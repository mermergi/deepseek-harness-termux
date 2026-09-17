package com.mermergi.dsh;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Polls the Termux-side status endpoint and reports what DSH is doing.
 *
 * <p>The decision of "working vs idle" lives in {@code ~/.dsh-app/status.mjs}, not here: it
 * reads the newest session log's last {@code turn/start} / {@code turn/end} marker, which is
 * the only signal that survives waiting on the model and long silent tool calls.
 *
 * <p>Starting the endpoint is a background {@code startService} into Termux, which Android may
 * refuse while we are in the background. To avoid depending on that, the app also nudges it
 * while it is still in the foreground — see {@link #ensureDaemon(Context)}.
 */
final class StatusPoller {

    interface Listener {
        /** @param state one of the {@code StatusBubble.STATE_*} constants. */
        void onStatus(int state);
    }

    private static final String ENDPOINT = "http://127.0.0.1:3098/status";
    private static final String KEY = "_Z2Fve3rcfvvahd4wDmLa0AvbxN061bp";
    private static final long INTERVAL_MS = 2000L;
    private static final long RETRY_DAEMON_EVERY = 6; // polls

    private final Context context;
    private final Listener listener;
    private final Handler ui = new Handler(Looper.getMainLooper());

    private volatile boolean running;
    private volatile boolean lastKnownDaemonUp;
    private Thread thread;

    StatusPoller(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    void start() {
        if (running) return;
        running = true;
        // No lambdas anywhere in this app: android.jar ships no LambdaMetafactory, so javac
        // cannot compile them against the platform stub.
        thread = new Thread(new Runnable() {
            @Override
            public void run() {
                loop();
            }
        }, "dsh-status");
        thread.setDaemon(true);
        thread.start();
    }

    void stop() {
        running = false;
        if (thread != null) {
            thread.interrupt();
            thread = null;
        }
    }

    private void loop() {
        boolean sawDaemon = false;
        int failures = 0;
        while (running) {
            String body = null;
            try {
                body = fetch();
                sawDaemon = true;
                failures = 0;
            } catch (Throwable ignored) {
                failures += 1;
            }
            if (body == null) {
                if (!sawDaemon || failures % RETRY_DAEMON_EVERY == 0) {
                    // One attempt to (re)start the endpoint; a no-op when it is already up.
                    TermuxRun.send(context, TermuxRun.BRIDGE_SCRIPT, "--status");
                }
                post(StatusBubble.STATE_UNKNOWN);
            } else {
                post(stateOf(body));
            }
            try {
                Thread.sleep(INTERVAL_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    private void post(final int state) {
        if (!running) return;
        ui.post(new Runnable() {
            @Override
            public void run() {
                if (running) listener.onStatus(state);
            }
        });
    }

    private String fetch() throws Exception {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(ENDPOINT).openConnection();
            connection.setRequestProperty("X-Dsh-Key", KEY);
            connection.setConnectTimeout(700);
            connection.setReadTimeout(2000);
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) return null;
            StringBuilder out = new StringBuilder();
            InputStream in = connection.getInputStream();
            BufferedReader reader = new BufferedReader(new InputStreamReader(in, "UTF-8"));
            String line;
            while ((line = reader.readLine()) != null) out.append(line);
            reader.close();
            return out.toString();
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static int stateOf(String json) {
        try {
            JSONObject object = new JSONObject(json);
            if (!object.optBoolean("serverUp", false)) return StatusBubble.STATE_STOPPED;
            String state = object.optString("state", "unknown");
            if ("working".equals(state)) return StatusBubble.STATE_WORKING;
            if ("idle".equals(state)) return StatusBubble.STATE_IDLE;
            return StatusBubble.STATE_UNKNOWN;
        } catch (Throwable t) {
            return StatusBubble.STATE_UNKNOWN;
        }
    }

    /**
     * Make sure the endpoint is alive while we are still in the foreground, where Android
     * allows starting a service in another app. Cheap: a single loopback probe.
     */
    static void ensureDaemon(final Context context) {
        if (!TermuxRun.hasPermission(context)) return;
        final Context app = context.getApplicationContext();
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                ensureDaemonBlocking(app);
            }
        }, "dsh-status-ensure");
        thread.setDaemon(true);
        thread.start();
    }

    private static void ensureDaemonBlocking(Context app) {
        HttpURLConnection connection = null;
        boolean up = false;
        try {
            connection = (HttpURLConnection) new URL(ENDPOINT).openConnection();
            connection.setRequestProperty("X-Dsh-Key", KEY);
            connection.setConnectTimeout(400);
            connection.setReadTimeout(600);
            up = connection.getResponseCode() == HttpURLConnection.HTTP_OK;
        } catch (Throwable ignored) {
            up = false;
        } finally {
            if (connection != null) connection.disconnect();
        }
        if (!up) TermuxRun.send(app, TermuxRun.BRIDGE_SCRIPT, "--status");
    }
}
