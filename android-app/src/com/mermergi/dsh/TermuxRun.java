package com.mermergi.dsh;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;

/** Firing commands into Termux through its exported {@code RUN_COMMAND} service. */
final class TermuxRun {

    /** Termux declares this as a *dangerous* permission, so it needs a runtime grant. */
    static final String PERMISSION = "com.termux.permission.RUN_COMMAND";

    static final String PACKAGE = "com.termux";

    private static final String TERMUX_PKG = PACKAGE;
    /**
     * Termux 0.118+ routes {@code com.termux.RUN_COMMAND} through a dedicated exported
     * service. The older {@code com.termux.app.TermuxService} target silently does nothing.
     */
    private static final String TERMUX_SERVICE = "com.termux.app.RunCommandService";
    private static final String ACTION_RUN_COMMAND = "com.termux.RUN_COMMAND";
    private static final String TERMUX_BASH = "/data/data/com.termux/files/usr/bin/bash";
    private static final String TERMUX_HOME = "/data/data/com.termux/files/home";

    static final String BRIDGE_SCRIPT = TERMUX_HOME + "/.dsh-app/bridge.sh";

    private TermuxRun() {
    }

    static boolean hasPermission(Context context) {
        return context.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED;
    }

    /** @return whether Termux accepted the intent; false means it never reached the service. */
    static boolean send(Context context, String... arguments) {
        try {
            Intent intent = new Intent();
            intent.setComponent(new ComponentName(TERMUX_PKG, TERMUX_SERVICE));
            intent.setAction(ACTION_RUN_COMMAND);
            intent.putExtra("com.termux.RUN_COMMAND_PATH", TERMUX_BASH);
            intent.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arguments);
            intent.putExtra("com.termux.RUN_COMMAND_WORKDIR", TERMUX_HOME);
            intent.putExtra("com.termux.RUN_COMMAND_BACKGROUND", true);
            intent.putExtra("com.termux.RUN_COMMAND_SESSION_ACTION", "0");
            intent.putExtra("com.termux.RUN_COMMAND_COMMAND_LABEL", "dsh-app");
            context.startService(intent);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }
}
