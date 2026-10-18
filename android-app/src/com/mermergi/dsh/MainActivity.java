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
import android.webkit.JavascriptInterface;
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
    private static final int NOTIFICATION_PERMISSION_REQUEST = 89;
    private static final String PERMISSION_RUN_COMMAND = TermuxRun.PERMISSION;
    /** How long DSH may sit idle before the floating bubble hides itself. */
    private static final long BUBBLE_IDLE_TIMEOUT_MS = 90000L;

    private static final int FILE_CHOOSER_REQUEST = 4711;

    /**
     * How long a boot may spin before the splash offers its retry buttons. A cold start loads
     * every plugin before the server prints its token, which is far longer than a warm one, and
     * a silent spinner is what makes that wait look like a hang.
     */
    private static final long SPLASH_PATIENCE_MS = 20000L;

    /** Must stay ahead of {@code ensure-server.mjs}'s own 110s wait, or the app gives up first. */
    private static final long HANDOFF_WAIT_MS = 120000L;

    /** Least time between two Termux nudges while the server stops answering. */
    private static final long NUDGE_MIN_INTERVAL_MS = 20000L;

    /** An outage at least this long is treated as a server replacement, worth a page reload. */
    private static final long LONG_OUTAGE_MS = 45000L;

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
    /** True from the moment a picker is launched until its result is handled. */
    private boolean filePickerLaunched;
    /** The request's own parameters, kept so a retry can rebuild the same picker intent. */
    private int pickerMode = WebChromeClient.FileChooserParams.MODE_OPEN;
    private String[] pickerAccept;
    /** The action the outstanding picker was launched with. */
    private String pickerAction = Intent.ACTION_OPEN_DOCUMENT;
    /** One retry per request: only a picker that answers OK with nothing is worth retrying. */
    private boolean pickerRetried;
    private volatile boolean bridgeDispatchFailed;
    private volatile boolean permissionRequested;
    private volatile int bootGeneration;
    private boolean authRetried;

    /**
     * Foreground server watch. A restarted server is a new process with a new launch token; the
     * page on screen reconnects its streams but keeps the turn state it had already derived, so
     * a Session can stay looking busy after the turn died with the server — Send then queues
     * instead of starting a turn and Stop has nothing left to cancel. Watching for the server to
     * come back and reloading the page is what clears that state without the user restarting.
     */
    private volatile boolean serverWentAway;
    private volatile boolean foregroundWatchRunning;
    private volatile long lastAutoReloadAt;
    /** Least time between two Termux nudges: a freeze is lifted by one intent, not by a storm. */
    private volatile long lastNudgeAt;
    /** When the server was first seen not answering; 0 while it is answering. */
    private volatile long awaySince;
    /** Set once a boot has a URL and is loading the page, so the patience notice stands down. */
    private volatile boolean loadingPage;

    private StatusBubble bubble;
    private StatusPoller statusPoller;
    private long idleSince;
    private boolean bubbleDismissedForThisBackground;
    /** One notification-permission prompt per launch; the platform drops overlapping ones. */
    private boolean notificationAskedThisLaunch;

    // --- pull to refresh ---
    private float pullStartY;
    private boolean pullArmed;

    // ---------------------------------------------------------------- lifecycle

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
        IslandNotifier.ensureChannel(this);
        // Hold the app in the foreground so the Termux-side server can be resurrected when
        // Android force-stops Termux (clearing its recent-tasks entry) between two sessions.
        KeepAliveService.start(this);
        probeIslandSupport();
        handleIntent(getIntent());
    }

    /**
     * Ask the system whether this app may drive Xiaomi's Super Island (焦点通知).
     *
     * HyperOS renders island notifications from ordinary notifications carrying a
     * {@code miui.focus.param} extra — but only for apps the platform has granted the focus
     * permission to, and Xiaomi grants that by application. Three documented queries answer
     * whether it is available here; the answers go to the Termux log, because the app has no
     * readable log of its own.
     */
    private void probeIslandSupport() {
        StringBuilder sb = new StringBuilder("island");
        String feature;
        try {
            Class<?> props = Class.forName("android.os.SystemProperties");
            java.lang.reflect.Method getBoolean =
                    props.getDeclaredMethod("getBoolean", String.class, boolean.class);
            feature = String.valueOf(getBoolean.invoke(null, "persist.sys.feature.island", false));
        } catch (Throwable t) {
            feature = "err:" + t.getClass().getSimpleName();
        }
        sb.append(" feature=").append(feature);

        String protocol;
        try {
            protocol = String.valueOf(Settings.System.getInt(
                    getContentResolver(), "notification_focus_protocol", -1));
        } catch (Throwable t) {
            protocol = "err:" + t.getClass().getSimpleName();
        }
        sb.append(" protocol=").append(protocol);

        String focus;
        try {
            Uri uri = Uri.parse("content://miui.statusbar.notification.public");
            Bundle extras = new Bundle();
            extras.putString("package", getPackageName());
            Bundle result = getContentResolver().call(uri, "canShowFocus", null, extras);
            focus = result == null
                    ? "null"
                    : String.valueOf(result.getBoolean("canShowFocus", false));
        } catch (Throwable t) {
            focus = "err:" + t.getClass().getSimpleName();
        }
        sb.append(" canShowFocus=").append(focus);

        try {
            android.app.NotificationManager nm =
                    (android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            sb.append(" notifEnabled=").append(nm != null && nm.areNotificationsEnabled());
        } catch (Throwable t) {
            sb.append(" notifEnabled=err");
        }
        Diag.report(sb.toString());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        Uri data = intent == null ? null : intent.getData();
        boolean handoff = data != null
                && "dshapp".equals(data.getScheme()) && "open".equals(data.getHost());
        // A plain relaunch — the launcher icon, or the floating bubble's "return to app" — must
        // not throw away a page that is already on screen. A fresh load aborts whatever RPC is
        // in flight, which is how a click on Send can simply vanish. Only an explicit hand-off
        // from Termux supersedes the live page.
        if (!handoff && web != null && !isSplashVisible()) {
            Diag.report("intent: page already on screen, keeping it");
            return;
        }
        handleIntent(intent);
    }

    @Override
    protected void onPause() {
        super.onPause();
        stopForegroundWatch();
        // From here on the keep-alive service owns the recovery: it is still in the foreground
        // as far as Android is concerned, and it can dispatch the bridge when the server dies.
        KeepAliveService.setAppForeground(false);
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
        // onActivityResult lands before onResume, so a picker still outstanding here means the
        // platform dropped its result: the page is left waiting and silently attaches nothing.
        // The flag is deliberately left set so the next real result still clears it.
        if (filePickerLaunched && pendingFileChooser != null && !pickerRetried) {
            Diag.report("fc: resumed with a picker outstanding, so no result was delivered");
        }
        stopBackgroundStatus();
        // The user is looking at the app: a good moment to make sure the status endpoint
        // exists, since starting a service in another app is unrestricted from the foreground.
        StatusPoller.ensureDaemon(this);
        startForegroundWatch();
        // The app boots itself while it is on screen; the service stands down to avoid a second
        // bridge dispatch racing the handoff endpoint's single poller.
        KeepAliveService.setAppForeground(true);
        maybeOfferBubble();
    }

    @Override
    protected void onDestroy() {
        stopBackgroundStatus();
        stopForegroundWatch();
        io.shutdownNow();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    // ---------------------------------------------------------------- floating status bubble

    /**
     * Begin reporting the work state once the app leaves the foreground.
     *
     * The floating bubble and the island notification are independent outlets: the bubble needs
     * the overlay permission, the island needs the notification permission, and either may be
     * granted without the other. Both are driven by one poller, which therefore starts if either
     * outlet is usable.
     */
    private void startBackgroundStatus() {
        bubbleDismissedForThisBackground = false;
        if (!TermuxRun.hasPermission(this)) return;
        boolean wantBubble = Settings.canDrawOverlays(this);
        boolean wantIsland = IslandNotifier.notificationsAllowed(this);
        if (!wantBubble && !wantIsland) return;

        if (wantBubble) {
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
            }
            if (bubble != null) {
                idleSince = 0L;
                bubble.update(StatusBubble.STATE_UNKNOWN, "");
            }
        }
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
        if (state == StatusBubble.STATE_WORKING) {
            if (IslandNotifier.notificationsAllowed(this)) {
                IslandNotifier.show(this, "工作中", "agent 正在执行任务");
            }
        } else if (IslandNotifier.notificationsAllowed(this)) {
            // Anything that is not "working" clears the island rather than leaving a stale claim.
            IslandNotifier.hide(this);
        }

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
        IslandNotifier.hide(this);
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
        boolean askedOverlay = prefs.getBoolean("bubble_offered", false);
        boolean askedNotifications = prefs.getBoolean("notifications_offered", false);
        if (isSplashVisible()) return;
        if (!TermuxRun.hasPermission(this)) return; // no point until Termux is reachable

        // Notification permission is an ordinary runtime dialog. Ask on every launch while it is
        // missing — Android stops showing the dialog after two refusals, so this cannot nag
        // forever, and a single swallowed request (the RUN_COMMAND prompt can still be up when the
        // page finishes loading) should not cost the island permanently.
        if (!IslandNotifier.notificationsAllowed(this)
                && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            boolean granted = checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    == android.content.pm.PackageManager.PERMISSION_GRANTED;
            Diag.report("notif-request granted=" + granted
                    + " askedBefore=" + askedNotifications
                    + " askedThisLaunch=" + notificationAskedThisLaunch);
            if (!granted && !notificationAskedThisLaunch) {
                notificationAskedThisLaunch = true;
                prefs.edit().putBoolean("notifications_offered", true).apply();
                try {
                    IslandNotifier.ensureChannel(this);
                    requestPermissions(
                            new String[]{"android.permission.POST_NOTIFICATIONS"},
                            NOTIFICATION_PERMISSION_REQUEST);
                } catch (Throwable t) {
                    Diag.report("notif-request-failed " + t.getClass().getSimpleName());
                }
            }
        }

        if (askedOverlay || Settings.canDrawOverlays(this)) return;
        prefs.edit().putBoolean("bubble_offered", true).apply();
        new AlertDialog.Builder(this)
                .setTitle("后台显示工作状态？")
                .setMessage("开启后，切到别的 App 时屏幕边上会有一个悬浮球，"
                        + "显示 DSH 是在工作、空闲还是服务已停止。需要「显示在其他应用上层」权限。\n\n"
                        + "另外，通知权限会用来在**灵动岛**上显示同样的状态，两项可以各自开关。")
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
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST) {
            filePickerLaunched = false;
            Uri[] uris = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            // Xiaomi's file manager answers OK with the selection in the Intent's extras and
            // getData() left empty, which the standard parser throws away. Recovering from the
            // extras is what turns that answer back into an attachment.
            boolean recovered = false;
            if ((uris == null || uris.length == 0) && resultCode == RESULT_OK) {
                uris = recoverUris(data);
                recovered = uris != null && uris.length > 0;
                if (!recovered) uris = null;
            }
            int count = uris == null ? 0 : uris.length;
            // Reading one byte here separates "the picker gave us nothing" from "the WebView could
            // not read what it gave us": both leave the page with an empty file list and the same
            // symptom, but only the second one is ours to work around.
            StringBuilder detail = new StringBuilder("fc result: code=").append(resultCode)
                    .append(" data=").append(data == null ? "null-intent" : "present")
                    .append(data == null ? "" : describeResult(data))
                    .append(recovered ? " recovered=" + count : "")
                    .append(" parsed=").append(count);
            for (int i = 0; i < count; i++) {
                detail.append(" | ").append(uris[i]).append(" read=").append(probeReadable(uris[i]));
            }
            Diag.report(detail.toString());
            // A picker that answers OK and hands back nothing is not the user cancelling: cancel
            // arrives as resultCode 0. Relaunching under the other document action is both the
            // recovery and the experiment, since the two actions resolve to different pickers.
            if (count == 0 && resultCode == RESULT_OK && !pickerRetried
                    && pendingFileChooser != null) {
                pickerRetried = true;
                Diag.report("fc result: OK with no usable document; retrying the other picker");
                Toast.makeText(this, "选择器没有返回文件，换一个再试", Toast.LENGTH_SHORT).show();
                launchPicker(Intent.ACTION_GET_CONTENT.equals(pickerAction)
                        ? Intent.ACTION_OPEN_DOCUMENT : Intent.ACTION_GET_CONTENT);
                return;
            }
            if (pendingFileChooser != null) {
                pendingFileChooser.onReceiveValue(count == 0 ? null : uris);
                pendingFileChooser = null;
            } else {
                Diag.report("fc result: nothing was waiting for the picker");
            }
            if (count == 0) Toast.makeText(this, "没有选中文件", Toast.LENGTH_SHORT).show();
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /**
     * Recover the picked documents from a result that {@code FileChooserParams.parseResult} rejects.
     *
     * Xiaomi's file manager returns {@code RESULT_OK} with an Intent that carries the selection in
     * its extras and leaves {@code getData()} null, so the standard parser finds nothing even
     * though the user did pick a file. The stream extra is the documented place for a shared
     * document and is checked first; anything else in the extras that holds a readable URI is
     * accepted after it, so the exact key does not have to be known in advance.
     *
     * @return the recovered documents, or null when the result carries none.
     */
    private Uri[] recoverUris(Intent data) {
        if (data == null) return null;
        java.util.ArrayList<Uri> found = new java.util.ArrayList<Uri>();
        android.os.Bundle extras = data.getExtras();
        if (extras != null) {
            collectUris(extras.get(Intent.EXTRA_STREAM), found);
            for (String key : extras.keySet()) {
                Object value = extras.get(key);
                if (value instanceof Uri) {
                    addIfReadable((Uri) value, found);
                } else if (value instanceof String) {
                    addIfReadable(asDocumentUri((String) value), found);
                }
            }
        }
        android.content.ClipData clip = data.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                addIfReadable(clip.getItemAt(i).getUri(), found);
            }
        }
        return found.isEmpty() ? null : found.toArray(new Uri[0]);
    }

    /** Add a URI and everything a stream extra may nest it in. */
    private void collectUris(Object value, java.util.ArrayList<Uri> into) {
        if (value instanceof Uri) {
            addIfReadable((Uri) value, into);
            return;
        }
        if (value instanceof java.util.List) {
            java.util.List<?> items = (java.util.List<?>) value;
            for (int i = 0; i < items.size(); i++) collectUris(items.get(i), into);
            return;
        }
        if (value instanceof Object[]) {
            Object[] items = (Object[]) value;
            for (int i = 0; i < items.length; i++) collectUris(items[i], into);
        }
    }

    /** @return the string as a document URI, or null when it does not name a readable file. */
    private Uri asDocumentUri(String text) {
        if (text == null || text.isEmpty()) return null;
        if (text.startsWith("content://") || text.startsWith("file://")) {
            Uri uri = Uri.parse(text);
            return "ok".equals(probeReadable(uri)) ? uri : null;
        }
        if (text.startsWith("/")) {
            // A bare path is only usable when this app can actually open it; a path in shared
            // storage is not readable under scoped storage, and saying so is the useful answer.
            java.io.File file = new java.io.File(text);
            if (!file.isFile()) return null;
            Uri uri = Uri.fromFile(file);
            return "ok".equals(probeReadable(uri)) ? uri : null;
        }
        return null;
    }

    private void addIfReadable(Uri uri, java.util.ArrayList<Uri> into) {
        if (uri == null || into.contains(uri)) return;
        // Keep only what this app can open: handing the page an unreadable URI produces an empty
        // file list, which is the symptom being fixed here.
        if ("ok".equals(probeReadable(uri))) into.add(uri);
    }

    /** @return a bounded description of a result Intent, including every extra it carries. */
    private String describeResult(Intent data) {
        StringBuilder out = new StringBuilder(" action=").append(data.getAction())
                .append(" type=").append(data.getType())
                .append(" uri=").append(data.getData())
                .append(" clip=").append(data.getClipData() == null
                        ? 0 : data.getClipData().getItemCount());
        android.os.Bundle extras = data.getExtras();
        if (extras == null || extras.isEmpty()) return out.append(" extras={}").toString();
        out.append(" extras={");
        for (String key : extras.keySet()) {
            if (out.length() > 500) {
                out.append(" ...");
                break;
            }
            out.append(' ').append(key).append('=').append(brief(extras.get(key)));
        }
        return out.append('}').toString();
    }

    /** @return a short printable form of one extra value, without dumping large payloads. */
    private String brief(Object value) {
        if (value == null) return "null";
        if (value instanceof String || value instanceof Uri) return shorten(String.valueOf(value));
        if (value instanceof java.util.List) {
            java.util.List<?> items = (java.util.List<?>) value;
            return "List(" + items.size() + ")" + (items.isEmpty() ? "" : "[" + brief(items.get(0)) + "]");
        }
        if (value instanceof Object[]) {
            Object[] items = (Object[]) value;
            return "Array(" + items.length + ")" + (items.length == 0 ? "" : "[" + brief(items[0]) + "]");
        }
        return value.getClass().getSimpleName();
    }

    private String shorten(String text) {
        if (text == null) return "null";
        return text.length() <= 140 ? text : text.substring(0, 140) + "...";
    }

    /** @return whether this app itself can open a picked document, for the diagnostic log. */
    private String probeReadable(Uri uri) {
        java.io.InputStream in = null;
        try {
            in = getContentResolver().openInputStream(uri);
            if (in == null) return "no-stream";
            byte[] one = new byte[1];
            return in.read(one) < 0 ? "empty" : "ok";
        } catch (Throwable t) {
            return "fail(" + t.getClass().getSimpleName() + ")";
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (Throwable ignored) {
                    // A probe that cannot close is still a usable answer.
                }
            }
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                           int[] grantResults) {
        if (requestCode == NOTIFICATION_PERMISSION_REQUEST) {
            boolean granted = grantResults.length > 0
                    && grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED;
            Diag.report("notif-result granted=" + granted
                    + " allowed=" + IslandNotifier.notificationsAllowed(this));
            return;
        }
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
        final long startedAt = System.currentTimeMillis();
        loadingPage = false;
        showStatus("正在连接 DSH…", "检查本机 3080 端口", true);
        // The app has no readable log of its own, so every branch this takes is shipped to the
        // Termux diagnostic sink: without it "卡住" is indistinguishable from "slow".
        Diag.report("boot: start restart=" + restartServer + " cookie=" + cookiePresent());
        ui.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (generation != bootGeneration || !isSplashVisible() || loadingPage) return;
                showStatus("后台服务还在启动…",
                        "首次启动要加载全部插件，可能要几十秒；也可以点重试", false);
            }
        }, SPLASH_PATIENCE_MS);
        bridgeDispatchFailed = false;
        io.execute(new Runnable() {
            @Override
            public void run() {
                if (!restartServer && cookieSessionStillGood()) {
                    Diag.report("boot: cookie accepted after "
                            + (System.currentTimeMillis() - startedAt) + "ms");
                    loadInWeb(BASE_URL + "/", generation);
                    return;
                }
                boolean dispatched = dispatchTermuxBridge(restartServer);
                String handoff = pollHandoff(dispatched ? HANDOFF_WAIT_MS : 5000L, generation);
                if (generation != bootGeneration) return;
                Diag.report("boot: bridge dispatched=" + dispatched
                        + " handoff=" + (handoff == null
                                ? "TIMEOUT" : "NO_TOKEN".equals(handoff) ? "NO_TOKEN" : "url")
                        + " after " + (System.currentTimeMillis() - startedAt) + "ms");
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

    /** @return whether the WebView holds any cookie for the app origin; diagnostics only. */
    private boolean cookiePresent() {
        try {
            String cookie = CookieManager.getInstance().getCookie(BASE_URL);
            return cookie != null && !cookie.isEmpty();
        } catch (Throwable t) {
            return false;
        }
    }

    // ---------------------------------------------------------------- foreground server watch

    /** Begin watching the loopback server while a page is on screen. Idempotent. */
    private void startForegroundWatch() {
        if (foregroundWatchRunning) return;
        foregroundWatchRunning = true;
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                int misses = 0;
                while (foregroundWatchRunning) {
                    if (serverAnswers()) {
                        if (serverWentAway) {
                            serverWentAway = false;
                            long outage = awaySince == 0 ? 0L : System.currentTimeMillis() - awaySince;
                            awaySince = 0L;
                            Diag.report("watch: server is back after " + (outage / 1000) + "s");
                            // Reload only after an outage long enough to have certainly broken
                            // the page's streams. Short flaps are normal here — the freezer
                            // thaws on any Termux intent — and reloading through them threw
                            // away whatever the user was doing, every couple of minutes.
                            if (outage >= LONG_OUTAGE_MS) reloadAfterRestart();
                        }
                        misses = 0;
                    } else {
                        misses += 1;
                        // Two consecutive misses, not one: a busy event loop can stall a probe
                        // for a moment, and reloading on that would throw away a live page.
                        if (misses >= 2 && !serverWentAway) {
                            serverWentAway = true;
                            awaySince = System.currentTimeMillis();
                            Diag.report("watch: server stopped answering");
                        }
                        // A frozen Termux answers nothing while its socket stays open (Android's
                        // cached-app freezer, which is what switching to another app causes), and
                        // the only thing that lifts that freeze is an explicit intent into Termux.
                        // The bridge is that intent; without it the page waits forever.
                        long now = System.currentTimeMillis();
                        if (serverWentAway && now - lastNudgeAt > NUDGE_MIN_INTERVAL_MS) {
                            lastNudgeAt = now;
                            Diag.report("watch: nudging Termux to unfreeze the server");
                            TermuxRun.send(MainActivity.this, TermuxRun.BRIDGE_SCRIPT);
                        }
                    }
                    try {
                        Thread.sleep(3000L);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }
            }
        }, "dsh-server-watch");
        thread.setDaemon(true);
        thread.start();
    }

    private void stopForegroundWatch() {
        foregroundWatchRunning = false;
    }

    /** @return whether the loopback server answers at all — any status, including 401. */
    private boolean serverAnswers() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(BASE_URL + "/").openConnection();
            connection.setConnectTimeout(2000);
            connection.setReadTimeout(2000);
            connection.getResponseCode();
            return true;
        } catch (Throwable t) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /**
     * Reload the page that survived a server restart.
     *
     * Debounced, and skipped while the splash is up (a boot is already in flight then). The page
     * is the only place the stale turn state lives, so reloading it is the whole fix.
     */
    private void reloadAfterRestart() {
        if (System.currentTimeMillis() - lastAutoReloadAt < 180000L) return;
        ui.post(new Runnable() {
            @Override
            public void run() {
                if (web == null || isSplashVisible()) return;
                if (System.currentTimeMillis() - lastAutoReloadAt < 180000L) return;
                lastAutoReloadAt = System.currentTimeMillis();
                Diag.report("watch: reloading the page after a long outage");
                web.reload();
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
                loadingPage = true;
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
        // Insurance for the file picker: some ROM pickers hand back a file:// document, and a
        // WebView with file access off drops it, reaching the page as an empty selection. Nothing
        // here loads local files, and an http:// page cannot read file:// anyway, so this only
        // widens what a picker may return.
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);

        // The settings page is web content, so it cannot stop a Termux process on its own.
        // Expose the one native action it needs: restart the server and hand back a fresh
        // token. Only the settings UI calls this, and only after its own confirmation dialog,
        // because a restart interrupts whatever turn is in flight.
        web.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void restartServer() {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        // Same state reset the splash "重新登录" button performs: drop the
                        // one-shot guards so the token exchange and any permission prompt
                        // can run again on the new server.
                        authRetried = false;
                        permissionRequested = false;
                        beginBoot(true);
                    }
                });
            }

            /**
             * Ask Termux to (re)start the status endpoint on 3098.
             *
             * <p>The settings page reads and writes the session initialization prompt through
             * that endpoint, because the prompt is `$DSH_HOME/AGENTS.md` — inside Termux's home
             * directory, which this app's UID cannot write (a direct attempt fails with
             * AccessDeniedException). The endpoint exits once idle, so the page nudges it here
             * and retries while it comes back.
             */
            @JavascriptInterface
            public void ensureStatusDaemon() {
                TermuxRun.send(MainActivity.this, TermuxRun.BRIDGE_SCRIPT, "--status");
            }
        }, "dshNative");

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
                // The token lives in the query string; the path alone is what identifies the load.
                Diag.report("page: finished " + (url == null ? "?" : url.split("\\?")[0]));
                hideSplash();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    Diag.report("page: main-frame error "
                            + (error == null ? "?" : error.getErrorCode() + " " + error.getDescription()));
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

        web.setWebChromeClient(new WebChromeClient() {
            /**
             * The page's console is the only view into the frontend from here: this app has no
             * readable log of its own, so browser-side failures are forwarded to the same sink the
             * status daemon writes.
             */
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage message) {
                if (message != null) {
                    String text = message.message();
                    if (text != null && text.length() > 300) text = text.substring(0, 300);
                    Diag.report("console: " + text + " @"
                            + message.sourceId() + ":" + message.lineNumber());
                }
                return false;
            }

            @Override
            public boolean onShowFileChooser(WebView view,
                                             android.webkit.ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (pendingFileChooser != null) {
                    pendingFileChooser.onReceiveValue(null);
                    pendingFileChooser = null;
                }
                pendingFileChooser = callback;
                pickerRetried = false;
                pickerMode = params == null
                        ? FileChooserParams.MODE_OPEN : params.getMode();
                pickerAccept = params == null ? null : params.getAcceptTypes();
                // Document providers are the modern, better-supported request; the older
                // get-content action is the fallback the retry path switches to.
                launchPicker(Intent.ACTION_OPEN_DOCUMENT);
                return true;
            }
        });

        FrameLayout.LayoutParams webParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        root.addView(web, 0, webParams);
    }

    /**
     * Launch the document picker for the request currently held in {@link #pendingFileChooser}.
     *
     * No chooser wrapper is used. The system already shows its own resolver whenever more than one
     * picker can answer, and wrapping a picker in {@code Intent.createChooser} adds a hop that this
     * device's resolver uses to lose the document: the picker was launched, the user picked a file,
     * and the result arrived as {@code RESULT_OK} with a null Intent, which the page sees as an
     * empty selection. When {@code action} cannot be launched at all the other document action is
     * tried before giving up.
     */
    private void launchPicker(String action) {
        Intent target = pickerIntent(action);
        target.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        pickerAction = action;
        filePickerLaunched = true;
        try {
            startActivityForResult(target, FILE_CHOOSER_REQUEST);
        } catch (Throwable t) {
            if (Intent.ACTION_GET_CONTENT.equals(action)) {
                Diag.report("fc: neither document action could be launched: " + t);
                abandonPicker("打不开文件选择器");
                return;
            }
            Diag.report("fc: " + action + " unusable (" + t + "); falling back");
            launchPicker(Intent.ACTION_GET_CONTENT);
            return;
        }
        Diag.report("fc: launched action=" + action + " type=" + target.getType()
                + " mode=" + pickerMode + " handlers=" + handlerSummary(target));
    }

    /** Give up on the outstanding request and tell the page the user picked nothing. */
    private void abandonPicker(String message) {
        filePickerLaunched = false;
        if (pendingFileChooser != null) {
            pendingFileChooser.onReceiveValue(null);
            pendingFileChooser = null;
        }
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }

    /**
     * Build the document-picker intent for the request currently held in
     * {@link #pendingFileChooser}.
     *
     * The type is widened to {@code *}{@code /*} and the accept list is passed as extra MIME types
     * instead: a picker that filters on the type alone shows nothing for an extension- or
     * multi-type accept list, which looks exactly like an empty folder.
     *
     * @param action - {@link Intent#ACTION_OPEN_DOCUMENT} or {@link Intent#ACTION_GET_CONTENT}.
     * @return the intent to launch.
     */
    private Intent pickerIntent(String action) {
        Intent built = new Intent(action);
        built.addCategory(Intent.CATEGORY_OPENABLE);
        built.setType("*/*");
        if (pickerMode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
            built.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        if (pickerAccept != null && pickerAccept.length > 0) {
            java.util.ArrayList<String> mimes = new java.util.ArrayList<String>();
            for (int i = 0; i < pickerAccept.length; i++) {
                String accept = pickerAccept[i];
                if (accept != null && accept.indexOf('/') >= 0) mimes.add(accept);
            }
            if (!mimes.isEmpty()) built.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0]));
        }
        return built;
    }

    /** @return the visible handlers for a picker intent, for the diagnostic log. */
    private String handlerSummary(Intent intent) {
        try {
            java.util.List<android.content.pm.ResolveInfo> handlers =
                    getPackageManager().queryIntentActivities(intent, 0);
            StringBuilder names = new StringBuilder("(").append(handlers.size()).append(")");
            for (int i = 0; i < handlers.size() && i < 8; i++) {
                names.append(' ').append(handlers.get(i).activityInfo.packageName)
                        .append('/').append(handlers.get(i).activityInfo.name);
            }
            return names.toString();
        } catch (Throwable t) {
            return "?";
        }
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
