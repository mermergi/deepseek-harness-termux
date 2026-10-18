package com.mermergi.dsh;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;

import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Keeps the Termux-side dsh server warm while this app is alive.
 *
 * <p>The failure this exists for: clearing Termux from the recent-tasks list force-stops
 * {@code com.termux}, which kills every process of that UID — including the {@code dsh web}
 * server, which is deliberately spawned detached (its parent is init, so nothing reaps it
 * when the bridge command finishes). The next time the app is opened the server is simply
 * gone, and the whole Termux round trip (start Termux → bridge → ensure-server → handoff →
 * load) is what the user waits through: measured at 19s on this device, spent entirely
 * before the page can load.
 *
 * <p>This service is the only thing on the device that can notice that from outside the
 * Termux UID. It holds the app in the foreground, probes the loopback server, and when the
 * server stops answering it fires the same bridge the app would — which restarts Termux and
 * the server. By the time the user opens a session the server is already answering again.
 *
 * <p>It deliberately does nothing while the app itself is in the foreground: the app's own
 * boot flow already dispatches the bridge in that state, and two dispatches racing would just
 * make the handoff endpoint hand the same URL to two pollers.
 *
 * <p>It is a foreground service rather than a background thread because Android only exempts
 * a foreground service from the background-start restrictions that would otherwise block the
 * recovery, and because that is what keeps this app itself from being frozen between probes.
 */
public class KeepAliveService extends Service {

    static final String ACTION_STOP = "com.mermergi.dsh.STOP_KEEPALIVE";

    private static final String CHANNEL_ID = "dsh-keepalive";
    /** Distinct from the island notification: both are ongoing and both must stay visible. */
    private static final int NOTIFICATION_ID = 0x4454;
    private static final String BASE_URL = "http://127.0.0.1:3080/";

    /** Probe cadence while the server answers: cheap, and only loopback. */
    private static final long PROBE_UP_MS = 10000L;
    /** Cadence after a miss, until the server answers again. */
    private static final long PROBE_DOWN_MS = 4000L;
    /** Least time between two bridge dispatches, so a slow cold start is not restarted forever. */
    private static final long NUDGE_MIN_INTERVAL_MS = 20000L;
    /**
     * How often to touch Termux while everything is healthy.
     *
     * Recovery alone is not enough: the freeze arrives about two minutes after the last
     * intent into Termux, so reacting to it means the server is genuinely dead for a few
     * seconds every couple of minutes — long enough for a request in flight to fail. A
     * `--status` dispatch is one short-lived node process and keeps the app out of the
     * freezer's reach.
     */
    private static final long KEEP_WARM_MS = 60000L;

    /** Whether the app's own boot flow owns the recovery right now. Set by MainActivity. */
    private static volatile boolean appForeground;
    /** Whether a recovery is believed to be in flight, for the notification text only. */
    private static volatile boolean running;

    private Handler handler;
    private HandlerThread worker;
    private long lastNudgeAt;
    private long lastKeepWarmAt;
    private boolean recovering;
    /** Grows while every attempt fails, so an unreachable Termux is not hammered forever. */
    private long nudgeIntervalMs = NUDGE_MIN_INTERVAL_MS;

    /** @return whether the service is currently holding the app in the foreground. */
    static boolean isRunning() {
        return running;
    }

    /** Let the service know the app is on screen, so it stands down while the app boots. */
    static void setAppForeground(boolean foreground) {
        appForeground = foreground;
    }

    /** Idempotent: Android re-delivers a foreground-service start as another onStartCommand. */
    static void start(Context context) {
        try {
            Intent intent = new Intent(context, KeepAliveService.class);
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Throwable t) {
            Diag.report("keepalive-start-failed " + t.getClass().getSimpleName());
        }
    }

    static void stop(Context context) {
        try {
            context.stopService(new Intent(context, KeepAliveService.class));
        } catch (Throwable ignored) {
            /* already gone */
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        ensureChannel();
        // The probe must not run on the main looper: HttpURLConnection throws
        // NetworkOnMainThreadException there, which a catch-all turns into "the server is
        // unreachable" — a permanently wrong answer that keeps the notification red and
        // keeps re-dispatching the bridge. A worker looper keeps the probe honest.
        worker = new HandlerThread("dsh-keepalive");
        worker.start();
        handler = new Handler(worker.getLooper());
        try {
            startForeground(NOTIFICATION_ID, buildNotification("等待后台服务", "每 10 秒检查一次 3080 端口"));
            running = true;
            Diag.report("keepalive: foreground service started");
        } catch (Throwable t) {
            // Android 12+ refuses a foreground start from the background. The app only starts
            // this from onResume, so this is the "restarted by the system while backgrounded"
            // case: leave the service standing so the next foreground trip starts it properly.
            Diag.report("keepalive-foreground-failed " + t.getClass().getSimpleName());
            running = false;
        }
        schedule(PROBE_UP_MS);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            Diag.report("keepalive: stopped from its notification");
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (handler != null) handler.removeCallbacksAndMessages(null);
        if (worker != null) worker.quitSafely();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ---------------------------------------------------------------- probe loop

    private void schedule(long delayMs) {
        if (handler == null) return;
        handler.removeCallbacks(tick);
        handler.postDelayed(tick, delayMs);
    }

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (serverAnswers()) {
                if (recovering) {
                    recovering = false;
                    nudgeIntervalMs = NUDGE_MIN_INTERVAL_MS;
                    Diag.report("keepalive: server is answering again");
                    updateNotification("后台服务正常", "Termux 里的 dsh 服务在线");
                }
                long now = SystemClock.elapsedRealtime();
                if (now - lastKeepWarmAt > KEEP_WARM_MS) {
                    lastKeepWarmAt = now;
                    // Cheap and idempotent: bridge.sh --status exits at once when the status
                    // endpoint is already served. The dispatch itself is the point — it is what
                    // keeps Termux out of the cached-app freezer.
                    TermuxRun.send(KeepAliveService.this, TermuxRun.BRIDGE_SCRIPT, "--status");
                }
                schedule(PROBE_UP_MS);
                return;
            }
            if (!appForeground
                    && SystemClock.elapsedRealtime() - lastNudgeAt > nudgeIntervalMs) {
                lastNudgeAt = SystemClock.elapsedRealtime();
                nudgeIntervalMs = Math.min(nudgeIntervalMs * 2, 120000L);
                recovering = true;
                Diag.report("keepalive: server unreachable, dispatching the bridge");
                updateNotification("正在唤醒 Termux", "后台服务不在线，已请求重新启动");
                // The same bridge the app itself uses: starts Termux when it is gone, then
                // starts the server when the port is closed.
                TermuxRun.send(KeepAliveService.this, TermuxRun.BRIDGE_SCRIPT);
            }
            schedule(PROBE_DOWN_MS);
        }
    };

    /** @return whether the loopback server answers at all — any status, including 401. */
    private boolean serverAnswers() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(BASE_URL).openConnection();
            connection.setConnectTimeout(1500);
            connection.setReadTimeout(1500);
            connection.getResponseCode();
            return true;
        } catch (Throwable t) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    // ---------------------------------------------------------------- notification

    private void ensureChannel() {
        try {
            NotificationManager manager =
                    (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return;
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "DSH 后台保活", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("保持 Termux 里的 DSH 服务在线，打开 App 时不用等它重新启动");
            channel.setSound(null, null);
            channel.enableVibration(false);
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        } catch (Throwable ignored) {
            /* no notification stack: the service still runs */
        }
    }

    private void updateNotification(String title, String text) {
        try {
            NotificationManager manager =
                    (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification(title, text));
        } catch (Throwable ignored) {
            /* the state is also in the diag log */
        }
    }

    private Notification buildNotification(String title, String text) {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, flags);
        PendingIntent stop = PendingIntent.getService(
                this, 1, new Intent(this, KeepAliveService.class).setAction(ACTION_STOP), flags);

        Notification.Builder builder = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher_foreground)
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setAutoCancel(false)
                .setShowWhen(false)
                .setContentIntent(content);
        try {
            builder.addAction(new Notification.Action.Builder(
                    null, "停止保活", stop).build());
        } catch (Throwable ignored) {
            /* the action is a convenience; the settings page can also stop it */
        }
        return builder.build();
    }
}
