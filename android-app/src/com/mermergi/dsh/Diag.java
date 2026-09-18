package com.mermergi.dsh;

/**
 * One-way debug channel from the app to the Termux status daemon's log.
 *
 * Purely a development aid, and a deliberately temporary one. The app has no log anyone can read
 * back — {@code logcat} only exposes Termux's own processes, and {@code /sdcard/Android/data} is
 * not reachable from Termux — so anything worth knowing about the app's runtime state has to be
 * shipped out over the loopback link that already exists for the status poll.
 *
 * The daemon bounds its own log, so this cannot grow without limit.
 */
final class Diag {

    private static final String ENDPOINT = "http://127.0.0.1:3098/diag?msg=";
    private static final String KEY = "_Z2Fve3rcfvvahd4wDmLa0AvbxN061bp";

    private Diag() {
    }

    static void report(String message) {
        final String target = ENDPOINT + android.net.Uri.encode(message);
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                java.net.HttpURLConnection connection = null;
                try {
                    connection = (java.net.HttpURLConnection)
                            new java.net.URL(target).openConnection();
                    connection.setRequestProperty("X-Dsh-Key", KEY);
                    connection.setConnectTimeout(500);
                    connection.setReadTimeout(800);
                    connection.getResponseCode();
                } catch (Throwable ignored) {
                    /* diagnostics must never affect behaviour */
                } finally {
                    if (connection != null) connection.disconnect();
                }
            }
        }, "dsh-diag");
        thread.setDaemon(true);
        thread.start();
    }
}
