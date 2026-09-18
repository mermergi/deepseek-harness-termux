package com.mermergi.dsh;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.os.Bundle;

/**
 * Drives Xiaomi's Super Island (焦点通知 / 超级岛) with the DSH work state.
 *
 * HyperOS renders an island notification out of an ordinary notification that carries a
 * {@code miui.focus.param} string extra holding a JSON blob — no MiPush, no vendor SDK. The
 * official guide documents three queries and this app answers them on this device as
 * {@code feature=true protocol=3 canShowFocus=true}: the platform permission Xiaomi normally
 * grants by email application is already present, so the only gate is the ordinary
 * POST_NOTIFICATIONS runtime permission.
 *
 * Picture slots are referenced by name from the JSON and resolved through a
 * {@code miui.focus.pics} bundle; this uses the app's own icon so nothing extra ships.
 *
 * The exact template field names are not fully public (the template library is a PDF), so the
 * payload sent is mirrored to the Termux log — if the island renders wrong, the log says what
 * was actually sent rather than what was meant.
 */
final class IslandNotifier {

    private static final String CHANNEL_ID = "dsh-island";
    /** Arbitrary but stable: updates replace the previous island instead of stacking. */
    private static final int NOTIFICATION_ID = 0x4453;

    private IslandNotifier() {
    }

    static void ensureChannel(Context context) {
        try {
            NotificationManager manager =
                    (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return;
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "DSH 工作状态", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("在灵动岛/状态栏上显示 agent 是否在工作");
            channel.setSound(null, null);
            channel.enableVibration(false);
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        } catch (Throwable ignored) {
            /* no notification stack, nothing to do */
        }
    }

    static boolean notificationsAllowed(Context context) {
        try {
            NotificationManager manager =
                    (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            return manager != null && manager.areNotificationsEnabled();
        } catch (Throwable t) {
            return false;
        }
    }

    /** Put the current state on the island. Repeated calls update the same notification. */
    static void show(Context context, String headline, String detail) {
        try {
            NotificationManager manager =
                    (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return;

            Intent open = new Intent(context, MainActivity.class);
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
                flags |= PendingIntent.FLAG_IMMUTABLE;
            }
            PendingIntent contentIntent = PendingIntent.getActivity(context, 0, open, flags);

            Notification.Builder builder = new Notification.Builder(context, CHANNEL_ID)
                    .setSmallIcon(R.mipmap.ic_launcher_foreground)
                    .setContentTitle("DSH")
                    .setContentText(detail)
                    .setOngoing(true)
                    .setOnlyAlertOnce(true)
                    .setAutoCancel(false)
                    .setContentIntent(contentIntent);

            // Picture slots are looked up by the names used in the JSON below. Decoded to a bitmap
            // rather than referenced as a resource: the launcher icon is an adaptive-icon XML, and
            // a slot that fails to resolve leaves the island's A area empty — which the vendor's
            // template rules reject outright, silently dropping the island while the status-bar
            // ticker keeps working.
            Icon icon = null;
            try {
                android.graphics.Bitmap bitmap = android.graphics.BitmapFactory.decodeResource(
                        context.getResources(), R.mipmap.ic_launcher_foreground);
                if (bitmap != null) icon = Icon.createWithBitmap(bitmap);
            } catch (Throwable t) {
                Diag.report("island-icon-failed " + t.getClass().getSimpleName());
            }
            if (icon == null) icon = Icon.createWithResource(context, R.mipmap.ic_launcher);
            Diag.report("island-icon " + (icon == null ? "null" : "ok"));
            Bundle pictures = new Bundle();
            pictures.putParcelable("miui.focus.pic_imageText", icon);
            pictures.putParcelable("miui.focus.pic_ticker", icon);
            pictures.putParcelable("miui.focus.pic_aod", icon);
            Bundle extras = new Bundle();
            extras.putBundle("miui.focus.pics", pictures);
            builder.addExtras(extras);

            Notification notification = builder.build();
            String payload = islandJson(headline, detail);
            notification.extras.putString("miui.focus.param", payload);
            manager.notify(NOTIFICATION_ID, notification);
            Diag.report("island-send " + payload);
        } catch (Throwable t) {
            Diag.report("island-send-failed " + t.getClass().getSimpleName() + " " + t.getMessage());
        }
    }

    static void hide(Context context) {
        try {
            NotificationManager manager =
                    (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) manager.cancel(NOTIFICATION_ID);
        } catch (Throwable ignored) {
            /* nothing to cancel */
        }
    }

    /**
     * The island payload, field-for-field against the published component schema.
     *
     * Three things an earlier revision got wrong, all of which can silently drop the island while
     * leaving the status-bar ticker working:
     *
     *   - {@code islandPriority} is required and was missing entirely.
     *   - {@code TextInfo} is {@code title} / {@code content} / {@code showHighlightColor}; the
     *     earlier {@code frontTitle} and {@code useHighLight} do not exist.
     *   - {@code baseInfo.type} 1 is the standard layout (icon left); 2 is a banner (icon right).
     *
     * Text is kept short on purpose: the vendor's design guide asks for at most four Han
     * characters per island field.
     */
    private static String islandJson(String headline, String detail) {
        String ticker = "DSH " + headline;
        String text = "{\"title\":\"" + headline + "\",\"content\":\"" + detail + "\","
                + "\"showHighlightColor\":false}";
        return "{"
                + "\"param_v2\":{"
                + "\"protocol\":3,"
                + "\"business\":\"dsh\","
                + "\"enableFloat\":true,"
                + "\"updatable\":true,"
                + "\"ticker\":\"" + ticker + "\","
                + "\"tickerPic\":\"miui.focus.pic_ticker\","
                + "\"aodTitle\":\"" + ticker + "\","
                + "\"aodPic\":\"miui.focus.pic_aod\","
                + "\"param_island\":{"
                + "\"islandProperty\":1,"
                + "\"islandPriority\":2,"
                + "\"bigIslandArea\":{"
                + "\"imageTextInfoLeft\":{"
                + "\"type\":1,"
                + "\"picInfo\":{\"type\":1,\"pic\":\"miui.focus.pic_imageText\"},"
                + "\"textInfo\":" + text
                + "}"
                + "},"
                + "\"smallIslandArea\":{"
                + "\"picInfo\":{\"type\":1,\"pic\":\"miui.focus.pic_imageText\"}"
                + "}"
                + "},"
                + "\"baseInfo\":{\"type\":1,\"title\":\"DSH\",\"content\":\"" + detail + "\","
                + "\"colorTitle\":\"#4D6BFE\"}"
                + "}"
                + "}";
    }
}
