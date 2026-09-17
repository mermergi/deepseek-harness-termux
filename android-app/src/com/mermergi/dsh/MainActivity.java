package com.mermergi.dsh;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * A thin native shell around the DeepSeek Harness web surface.
 *
 * <p>Boot order:
 * <ol>
 *   <li>Fast path — if we already hold a valid browser-session cookie and the server answers
 *       {@code 200} on {@code /}, just load it. No Termux involvement at all.</li>
 *   <li>Slow path — ask Termux to run the bridge script (starts {@code dsh web} when it is not
 *       running, then publishes the process-token URL on a short-lived loopback endpoint), poll
 *       that endpoint, and load the authenticated URL so the WebView can mint its cookie.</li>
 * </ol>
 */
public class MainActivity extends Activity {

    private static final String BASE_URL = "http://127.0.0.1:3080";
    private static final String HANDOFF_URL = "http://127.0.0.1:3099/handoff";

    /** Shared secret for the loopback handoff endpoint; also baked into the bridge script. */
    private static final String HANDOFF_KEY = "_Z2Fve3rcfvvahd4wDmLa0AvbxN061bp";

    private static final int PERMISSION_REQUEST = 88;
    private static final String PERMISSION_RUN_COMMAND = TermuxRun.PERMISSION;
    /** How long DSH may sit idle before the floating bubble hides itself. */
    private static final long BUBBLE_IDLE_TIMEOUT_MS = 90000L;

    private static final int FILE_CHOOSER_REQUEST = 4711;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private WebView web;
    private FrameLayout root;
    private LinearLayout splash;
    private TextView statusText;
    private TextView detailText;
    private ProgressBar progress;
    private Button retryButton;
    private Button termuxButton;
    private Button restartButton;

    private android.webkit.ValueCallback<Uri[]> pendingFileChooser;
    private volatile boolean bridgeDispatchFailed;
    private volatile boolean permissionRequested;
    private volatile int bootGeneration;
    private boolean authRetried;

    private StatusBubble bubble;
    private StatusPoller statusPoller;
    private long idleSince;
    private boolean bubbleDismissedForThisBackground;

    // --- pull to refresh ---
    private float pullStartY;
    private boolean pullArmed;

    // ---------------------------------------------------------------- lifecycle

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) {
            web.onPause();
            CookieManager.getInstance().flush();
        }
        startBackgroundStatus();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        stopBackgroundStatus();
        // The user is looking at the app: a good moment to make sure the status endpoint
        // exists, since starting a service in another app is unrestricted from the foreground.
        StatusPoller.ensureDaemon(this);
        maybeOfferBubble();
    }

    @Override
    protected void onDestroy() {
        stopBackgroundStatus();
        io.shutdownNow();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    // ---------------------------------------------------------------- floating status bubble

    /** Show the bubble and begin polling once the app leaves the foreground. */
    private void startBackgroundStatus() {
        bubbleDismissedForThisBackground = false;
        if (!Settings.canDrawOverlays(this)) return;
        if (!TermuxRun.hasPermission(this)) return;
        if (bubble == null) {
            bubble = new StatusBubble(this, new Runnable() {
                @Override
                public void run() {
                    returnToApp();
                }
            });
        }
        try {
            bubble.show();
        } catch (Throwable t) {
            bubble = null;
            return;
        }
        idleSince = 0L;
        bubble.update(StatusBubble.STATE_UNKNOWN, "");
        if (statusPoller == null) {
            statusPoller = new StatusPoller(this, new StatusPoller.Listener() {
                @Override
                public void onStatus(int state) {
                    onBackgroundStatus(state);
                }
            });
        }
        statusPoller.start();
    }

    private void onBackgroundStatus(int state) {
        if (bubble == null) return;
        long now = System.currentTimeMillis();
        if (state == StatusBubble.STATE_IDLE) {
            if (idleSince == 0L) idleSince = now;
            // Nothing happening for a while: get out of the way until something does.
            if (now - idleSince > BUBBLE_IDLE_TIMEOUT_MS) {
                bubble.hide();
                return;
            }
        } else {
            idleSince = 0L;
            if (!bubble.isShowing() && !bubbleDismissedForThisBackground) {
                try {
                    bubble.show();
                } catch (Throwable ignored) {
                    return;
                }
            }
        }
        bubble.update(state, "");
    }

    private void stopBackgroundStatus() {
        if (statusPoller != null) {
            statusPoller.stop();
            statusPoller = null;
        }
        if (bubble != null) bubble.hide();
    }

    private void returnToApp() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        try {
            startActivity(intent);
        } catch (Throwable ignored) {
            /* nothing sensible to do from an overlay */
        }
    }

    /** One-time offer to grant "display over other apps", which the bubble needs. */
    private void maybeOfferBubble() {
        android.content.SharedPreferences prefs =
                getSharedPreferences("dsh_app", MODE_PRIVATE);
        if (prefs.getBoolean("bubble_offered", false)) return;
        if (Settings.canDrawOverlays(this)) return;
        if (!TermuxRun.hasPermission(this)) return; // no point until Termux is reachable
        if (isSplashVisible()) return;
        prefs.edit().putBoolean("bubble_offered", true).apply();
        new AlertDialog.Builder(this)
                .setTitle("后台显示工作状态？")
                .setMessage("开启后，切到别的 App 时屏幕边上会有一个悬浮球，"
                        + "显示 DSH 是在工作、空闲还是服务已停止。需要「显示在其他应用上层」权限。")
                .setPositiveButton("开启", new android.content.DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(android.content.DialogInterface dialog, int which) {
                        try {
                            startActivity(new Intent(
                                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                                    Uri.parse("package:" + getPackageName())));
                        } catch (Throwable ignored) {
                            /* some ROMs have no such screen */
                        }
                    }
                })
                .setNegativeButton("以后再说", null)
                .show();
    }

    @Override
    public void onBackPressed() {
        if (isSplashVisible()) {
            // The splash owns the screen: leaving the app is the sensible default.
            super.onBackPressed();
            return;
        }
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {        if (requestCode == FILE_CHOOSER_REQUEST) {
            if (pendingFileChooser != null) {
                pendingFileChooser.onReceiveValue(
                        WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                pendingFileChooser = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                           int[] grantResults) {
        if (requestCode == PERMISSION_REQUEST) {
            // Granted or not, re-run the boot flow: it will either reach Termux now or fall
            // back to the "open Termux manually" screen.
            beginBoot();
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    // ---------------------------------------------------------------- intent routing

    private void handleIntent(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data != null && "dshapp".equals(data.getScheme()) && "open".equals(data.getHost())) {
            final String url = data.getQueryParameter("url");
            if (url != null && !url.isEmpty()) {
                // A hand-off from Termux supersedes any boot attempt still in flight.
                bootGeneration++;
                loadInWeb(url, bootGeneration);
                return;
            }
        }
        beginBoot();
    }

    // ---------------------------------------------------------------- boot

    /**
     * Boot attempts can overlap: the permission dialog restarts the flow while the previous
     * attempt is still polling, and a Termux hand-off can arrive mid-flight. Only the newest
     * generation is allowed to touch the UI, so a slow loser cannot paint an error screen on
     * top of a successful connection.
     */
    private void beginBoot() {
        beginBoot(false);
    }

    /**
     * @param restartServer stop and restart the dsh server so it mints a fresh launch token.
     *                      Only the explicit "重新登录" action passes true: it interrupts any
     *                      turn in flight, so it must never happen behind the user's back.
     */
    private void beginBoot(final boolean restartServer) {
        final int generation = ++bootGeneration;
        showStatus("正在连接 DSH…", "检查本机 3080 端口", true);
        bridgeDispatchFailed = false;
        io.execute(new Runnable() {
            @Override
            public void run() {
                if (!restartServer && cookieSessionStillGood()) {
                    loadInWeb(BASE_URL + "/", generation);
                    return;
                }
                boolean dispatched = dispatchTermuxBridge(restartServer);
                String handoff = pollHandoff(dispatched ? 60000L : 5000L, generation);
                if (generation != bootGeneration) return;
                if (handoff == null) {
                    showBootFailure(generation);
                    return;
                }
                if ("NO_TOKEN".equals(handoff)) {
                    // Server is up but we could not read a fresh token; a stale cookie may still work.
                    loadInWeb(BASE_URL + "/", generation);
                    return;
                }
                loadInWeb(handoff, generation);
            }
        });
    }

    /** @return true when an existing browser-session cookie is accepted by a live server. */
    private boolean cookieSessionStillGood() {
        String cookie;
        try {
            cookie = CookieManager.getInstance().getCookie(BASE_URL);
        } catch (Throwable t) {
            return false;
        }
        if (cookie == null || cookie.isEmpty()) return false;
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(BASE_URL + "/").openConnection();
            connection.setRequestProperty("Cookie", cookie);
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(700);
            connection.setReadTimeout(900);
            return connection.getResponseCode() == HttpURLConnection.HTTP_OK;
        } catch (Throwable t) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** Ask Termux to run the bridge script. @return whether the intent was handed to Termux. */
    private boolean dispatchTermuxBridge(boolean restartServer) {
        if (!TermuxRun.hasPermission(this)) {
            // Termux declares RUN_COMMAND as a dangerous permission, so it can only be
            // obtained from a user-visible dialog. Ask once per app run — re-asking on
            // every retry would trap the user in a dialog loop after a denial.
            if (!permissionRequested) {
                permissionRequested = true;
                ui.post(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            requestPermissions(
                                    new String[]{PERMISSION_RUN_COMMAND}, PERMISSION_REQUEST);
                        } catch (Throwable t) {
                            bridgeDispatchFailed = true;
                        }
                    }
                });
            } else {
                bridgeDispatchFailed = true;
            }
            return false;
        }
        boolean sent = restartServer
                ? TermuxRun.send(this, TermuxRun.BRIDGE_SCRIPT, "--restart")
                : TermuxRun.send(this, TermuxRun.BRIDGE_SCRIPT);
        if (!sent) bridgeDispatchFailed = true;
        return sent;
    }

    /** @return the URL published by the bridge, {@code "NO_TOKEN"}, or {@code null} on timeout. */
    private String pollHandoff(long timeoutMs, int generation) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (generation != bootGeneration) return null;
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(HANDOFF_URL).openConnection();
                connection.setRequestProperty("X-Dsh-Key", HANDOFF_KEY);
                connection.setConnectTimeout(600);
                connection.setReadTimeout(1200);
                int code = connection.getResponseCode();
                if (code == HttpURLConnection.HTTP_OK) {
                    return readAll(connection.getInputStream()).trim();
                }
            } catch (Throwable ignored) {
                // Bridge not listening yet — expected while Termux boots.
            } finally {
                if (connection != null) connection.disconnect();
            }
            try {
                Thread.sleep(250);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return null;
            }
        }
        return null;
    }

    private static String readAll(InputStream in) throws Exception {
        StringBuilder out = new StringBuilder();
        BufferedReader reader = new BufferedReader(new InputStreamReader(in, "UTF-8"));
        String line;
        while ((line = reader.readLine()) != null) out.append(line).append('\n');
        reader.close();
        return out.toString();
    }

    private void showBootFailure(final int generation) {
        ui.post(new Runnable() {
            @Override
            public void run() {
                if (generation != bootGeneration) return;
                String detail = bridgeDispatchFailed
                        ? "没能让 Termux 执行 bridge。检查：Termux 是否已安装、"
                        + "~/.termux/termux.properties 里 allow-external-apps 是否为 true、"
                        + "以及 DSH 是否拿到了「在 Termux 中运行命令」权限。"
                        : "后台服务没有在预期时间内就绪，可以点重试。";
                showStatus("DSH 没起来", detail, false);
            }
        });
    }

    /**
     * The server answers 401 even after a fresh token exchange: it is running under a token we
     * cannot read (its log was wiped with $TMPDIR). Only a restart can mint a new one.
     */
    private void showAuthFailure(final int generation) {
        ui.post(new Runnable() {
            @Override
            public void run() {
                if (generation != bootGeneration) return;
                showStatus("登录已失效", "后台服务正在用一个读不到的 token 运行。"
                        + "点「重新登录」重启它（会打断正在进行的对话）。", false);
                retryButton.setVisibility(View.GONE);
            }
        });
    }

    private void loadInWeb(final String url, final int generation) {
        ui.post(new Runnable() {
            @Override
            public void run() {
                if (generation != bootGeneration) return;
                attachWebView();
                showStatus("正在加载界面…", url, true);
                web.loadUrl(url);
            }
        });
    }

    // ---------------------------------------------------------------- UI

    private void buildUi() {
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        splash = new LinearLayout(this);
        splash.setOrientation(LinearLayout.VERTICAL);
        splash.setGravity(Gravity.CENTER);
        splash.setBackgroundColor(Color.parseColor("#0B0B0F"));
        int pad = dp(28);
        splash.setPadding(pad, pad, pad, pad);

        progress = new ProgressBar(this);
        LinearLayout.LayoutParams progressParams =
                new LinearLayout.LayoutParams(dp(40), dp(40));
        progressParams.bottomMargin = dp(20);
        splash.addView(progress, progressParams);

        statusText = new TextView(this);
        statusText.setTextColor(Color.WHITE);
        statusText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        statusText.setGravity(Gravity.CENTER);
        splash.addView(statusText, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        detailText = new TextView(this);
        detailText.setTextColor(Color.parseColor("#8A8A96"));
        detailText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        detailText.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams detailParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        detailParams.topMargin = dp(10);
        splash.addView(detailText, detailParams);

        retryButton = new Button(this);
        retryButton.setText("重试");
        retryButton.setAllCaps(false);
        retryButton.setVisibility(View.GONE);
        retryButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                authRetried = false;
                // A manual retry is also the escape hatch for a permission the user denied
                // earlier, so let it ask again.
                permissionRequested = false;
                beginBoot();
            }
        });
        LinearLayout.LayoutParams retryParams =
                new LinearLayout.LayoutParams(dp(180), ViewGroup.LayoutParams.WRAP_CONTENT);
        retryParams.topMargin = dp(26);
        splash.addView(retryButton, retryParams);

        termuxButton = new Button(this);
        termuxButton.setText("打开 Termux");
        termuxButton.setAllCaps(false);
        termuxButton.setVisibility(View.GONE);
        termuxButton.setTypeface(Typeface.DEFAULT);
        termuxButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openTermux();
            }
        });
        LinearLayout.LayoutParams termuxParams =
                new LinearLayout.LayoutParams(dp(180), ViewGroup.LayoutParams.WRAP_CONTENT);
        termuxParams.topMargin = dp(8);
        splash.addView(termuxButton, termuxParams);

        restartButton = new Button(this);
        restartButton.setText("重新登录");
        restartButton.setAllCaps(false);
        restartButton.setVisibility(View.GONE);
        restartButton.setTypeface(Typeface.DEFAULT);
        restartButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                // Explicitly consented: this restarts the server, which interrupts any turn
                // that is currently running.
                authRetried = false;
                permissionRequested = false;
                beginBoot(true);
            }
        });
        LinearLayout.LayoutParams restartParams =
                new LinearLayout.LayoutParams(dp(180), ViewGroup.LayoutParams.WRAP_CONTENT);
        restartParams.topMargin = dp(8);
        splash.addView(restartButton, restartParams);

        root.addView(splash, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
    }

    private void attachWebView() {
        if (web != null) return;

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setTextZoom(100);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return routeUrl(request.getUrl());
            }

            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return routeUrl(Uri.parse(url));
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                hideSplash();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    showBootFailure(bootGeneration);
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                            android.webkit.WebResourceResponse response) {
                if (request == null || !request.isForMainFrame() || response == null) return;
                if (response.getStatusCode() != 401) return;
                if (!authRetried) {
                    // The 30-day cookie expired (or the signing secret rotated): re-run the token
                    // exchange once before involving the user.
                    authRetried = true;
                    beginBoot();
                    return;
                }
                // Still unauthenticated: the server is running with a token we cannot read.
                // Offer the explicit restart, which mints a fresh one.
                showAuthFailure(bootGeneration);
            }
        });

        // Pull-to-refresh, without pulling in androidx: return false so the WebView keeps
        // handling the gesture normally, and just watch for a long downward drag at the top.
        web.setOnTouchListener(new View.OnTouchListener() {
            @Override
            public boolean onTouch(View v, MotionEvent event) {
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        pullArmed = web.getScrollY() == 0;
                        pullStartY = event.getY();
                        break;
                    case MotionEvent.ACTION_MOVE:
                        if (pullArmed && event.getY() - pullStartY > dp(140)) {
                            pullArmed = false;
                            web.reload();
                            Toast.makeText(MainActivity.this, "已刷新", Toast.LENGTH_SHORT).show();
                        }
                        break;
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        pullArmed = false;
                        break;
                    default:
                        break;
                }
                return false;
            }
        });

        // WebView cannot save files on its own; hand anything downloadable to the browser.
        web.setDownloadListener(new android.webkit.DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimeType, long contentLength) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Throwable t) {
                    Toast.makeText(MainActivity.this, "没有应用能下载这个文件", Toast.LENGTH_SHORT).show();
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {            @Override
            public boolean onShowFileChooser(WebView view,
                                             android.webkit.ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (pendingFileChooser != null) {
                    pendingFileChooser.onReceiveValue(null);
                    pendingFileChooser = null;
                }
                pendingFileChooser = callback;
                try {
                    Intent chooser = params.createIntent();
                    chooser.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(
                            Intent.createChooser(chooser, "选择文件"), FILE_CHOOSER_REQUEST);
                } catch (Throwable t) {
                    pendingFileChooser = null;
                    Toast.makeText(MainActivity.this, "打不开文件选择器", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        });

        FrameLayout.LayoutParams webParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        root.addView(web, 0, webParams);
    }

    /** @return true when the navigation was handed off outside the WebView. */
    private boolean routeUrl(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if ("http".equals(scheme) || "https".equals(scheme)) {
            if ("127.0.0.1".equals(host) || "localhost".equals(host)) return false;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Throwable t) {
            Toast.makeText(this, "没有应用能打开这个链接", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    private void showStatus(String title, String detail, boolean busy) {
        statusText.setText(title);
        detailText.setText(detail == null ? "" : detail);
        progress.setVisibility(busy ? View.VISIBLE : View.GONE);
        retryButton.setVisibility(busy ? View.GONE : View.VISIBLE);
        restartButton.setVisibility(busy ? View.GONE : View.VISIBLE);
        // The "open Termux" escape hatch only makes sense when we could not reach Termux.
        termuxButton.setVisibility(!busy && bridgeDispatchFailed ? View.VISIBLE : View.GONE);
        splash.setVisibility(View.VISIBLE);
        splash.bringToFront();
    }

    private void hideSplash() {
        boolean wasVisible = isSplashVisible();
        splash.setVisibility(View.GONE);
        if (wasVisible) maybeOfferBubble();
    }

    private boolean isSplashVisible() {
        return splash != null && splash.getVisibility() == View.VISIBLE;
    }

    private void openTermux() {
        try {
            Intent launch = getPackageManager().getLaunchIntentForPackage(TermuxRun.PACKAGE);
            if (launch == null) {
                Toast.makeText(this, "没找到 Termux", Toast.LENGTH_SHORT).show();
                return;
            }
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(launch);
        } catch (Throwable t) {
            Toast.makeText(this, "打不开 Termux", Toast.LENGTH_SHORT).show();
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
