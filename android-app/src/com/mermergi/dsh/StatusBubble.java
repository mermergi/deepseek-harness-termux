package com.mermergi.dsh;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.util.TypedValue;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewTreeObserver;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.Collections;

/**
 * The floating "what is DSH doing" bubble.
 *
 * The shape follows one rule, and only one: **docked or not**.
 *
 *   - **Docked** — a slim hollow arc hugging the left or right screen edge: a `(` on the right, a
 *     `)` on the left. Nothing but the stroke carries the state, so it stays elegant at 24x56dp.
 *   - **Away from an edge** — the pill, `● DSH 工作中`, which has room to spell the state out.
 *
 * Colours carry the state throughout: blue working / green idle / red stopped / grey unknown,
 * plus a slow breath on "working" so the live state has a cue beyond colour.
 *
 * Interaction: drag it anywhere — drop it against an edge and it docks as the arc, drop it in the
 * open and it stays a pill. Tap toggles between the two, double tap opens the app.
 *
 * ## Measuring the screen edge instead of assuming it
 *
 * Snap-on-release used to fail at the right edge and nowhere else. The asymmetry was the clue:
 * the left edge is 0 in every coordinate space, so {@code params.x} measures that gap directly,
 * while the right gap needs a screen width and inherits every error in it. Docked, the window
 * manager has already put the window exactly on the edge, so {@link #calibrate()} asks the view
 * where it actually landed and records that. Snap decisions then compare against a measured
 * number, and the decision uses the *window's* gap to the edge — the earlier finger-based rule
 * silently broke for the ~350px pill, whose edge reaches the screen while the finger is still far
 * from it.
 *
 * ## What is deliberately not measured
 *
 * Nothing that changes shape mid-flight relies on a fresh {@code getWidth()} — adding a window is
 * asynchronous, so that number still describes the previous shape. Docked positions are expressed
 * with {@code gravity = START/END} and {@code x = 0}; the free pill re-clamps once, after the
 * layout that follows its own change, via {@link #placeAfterLayout()}.
 */
final class StatusBubble {

    /** States the poller can report. */
    static final int STATE_UNKNOWN = 0;
    static final int STATE_IDLE = 1;
    static final int STATE_WORKING = 2;
    static final int STATE_STOPPED = 3;

    private static final String PREFS = "dsh_app";
    private static final String KEY_X = "bubble_x";
    private static final String KEY_Y = "bubble_y";
    private static final String KEY_SNAPPED = "bubble_snapped";
    private static final String KEY_SIDE = "bubble_side";

    /**
     * Docked arc geometry: a *segment* of a circle, not a semicircle.
     *
     * The view is a bit wider than the ink so there is something to aim at; the arc itself is
     * centred in it. Radius and sweep are the shape the user picked off a rendered comparison.
     */
    private static final int ARC_W_DP = 12;
    private static final int ARC_H_DP = 34;
    private static final int ARC_STROKE_DP = 3;
    private static final int ARC_RADIUS_DP = 19;
    private static final int ARC_SWEEP_DEG = 90;

    private static final int DRAG_SLOP_DP = 6;
    /** Minimum gap to an edge that still counts as "released against it". */
    private static final int SNAP_DP = 48;
    private static final long AUTO_DOCK_MS = 5000L;

    private final Context context;
    private final WindowManager windowManager;
    private final Runnable onTap;
    private final SharedPreferences prefs;
    private final GestureDetector gestures;

    private LinearLayout root;
    private View statusDot;
    private TextView label;
    private ArcDrawable arc;
    private WindowManager.LayoutParams params;

    private int state = STATE_UNKNOWN;
    private String note = "";
    /** Showing the pill rather than the docked arc. */
    private boolean expanded;
    /** Docked to an edge rather than floating. */
    private boolean snapped;
    /** -1 left edge, +1 right edge — also which way the arc opens. */
    private int side = 1;
    private boolean dragging;

    /** Empirically measured screen edges, in the same space as {@code MotionEvent.getRawX()}. */
    private int edgeLeft;
    private int edgeRight;
    private boolean edgesMeasured;

    private final Handler handler = new Handler(Looper.getMainLooper());

    private final Runnable pulse = new Runnable() {
        @Override
        public void run() {
            if (root == null) return;
            root.setAlpha(root.getAlpha() > 0.99f ? 0.45f : 1f);
            handler.postDelayed(this, 700);
        }
    };

    /** A docked bubble is furniture; a pill left floating should not stay in the way. */
    private final Runnable autoDock = new Runnable() {
        @Override
        public void run() {
            if (root == null || dragging || !expanded || snapped) return;
            snapTo(nearestSide());
        }
    };

    /** Reads back where the docked window actually landed; the only trustworthy edge source. */
    private final Runnable calibrate = new Runnable() {
        @Override
        public void run() {
            if (root == null || !snapped || root.getWidth() == 0) return;
            int[] location = new int[2];
            try {
                root.getLocationOnScreen(location);
            } catch (Throwable ignored) {
                return;
            }
            if (side < 0) {
                edgeLeft = location[0];
                if (!edgesMeasured) edgeRight = edgeLeft + screenWidth();
            } else {
                edgeRight = location[0] + root.getWidth();
                if (!edgesMeasured) edgeLeft = 0;
            }
            edgesMeasured = true;
            Diag.report("calib side=" + side + " loc=" + location[0] + " w=" + root.getWidth()
                    + " => L=" + edgeLeft + " R=" + edgeRight + " sw=" + screenWidth());
        }
    };

    StatusBubble(Context context, Runnable onTap) {
        this.context = context.getApplicationContext();
        this.windowManager = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        this.onTap = onTap;
        this.prefs = this.context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        this.gestures = new GestureDetector(this.context, new TouchGestures());
    }

    boolean isShowing() {
        return root != null;
    }

    void show() {
        if (root != null) return;

        LinearLayout container = new LinearLayout(context);
        container.setOrientation(LinearLayout.HORIZONTAL);
        container.setGravity(Gravity.CENTER_VERTICAL);

        statusDot = new View(context);
        LinearLayout.LayoutParams dotParams = new LinearLayout.LayoutParams(dp(10), dp(10));
        dotParams.rightMargin = dp(9);
        container.addView(statusDot, dotParams);

        label = new TextView(context);
        label.setTextColor(Color.WHITE);
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        container.addView(label, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        arc = new ArcDrawable(dp(ARC_STROKE_DP), dp(ARC_RADIUS_DP), ARC_SWEEP_DEG);

        params = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                        : WindowManager.LayoutParams.TYPE_PHONE,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);

        snapped = prefs.getBoolean(KEY_SNAPPED, true);
        // Docked and floating are the only two looks, so the stored dock state decides both.
        expanded = !snapped;
        side = prefs.getInt(KEY_SIDE, 1) >= 0 ? 1 : -1;
        params.y = prefs.getInt(KEY_Y, dp(220));
        params.x = prefs.getInt(KEY_X, dp(12));
        edgeLeft = 0;
        edgeRight = screenWidth();

        container.setOnTouchListener(new TouchHandler());
        root = container;
        applyShape();
        render();

        try {
            windowManager.addView(root, params);
        } catch (Throwable t) {
            root = null;
            throw t;
        }
        place();
    }

    void hide() {
        handler.removeCallbacks(pulse);
        handler.removeCallbacks(autoDock);
        handler.removeCallbacks(calibrate);
        if (root == null) return;
        try {
            windowManager.removeView(root);
        } catch (Throwable ignored) {
            /* already detached */
        }
        root = null;
    }

    void update(int newState, String newNote) {
        state = newState;
        note = newNote == null ? "" : newNote;
        render();
    }

    // ------------------------------------------------------------------ rendering

    private int stateColor() {
        switch (state) {
            case STATE_WORKING:
                return Color.parseColor("#4D6BFE");
            case STATE_IDLE:
                return Color.parseColor("#3DD68C");
            case STATE_STOPPED:
                return Color.parseColor("#E5484D");
            default:
                return Color.parseColor("#8A8A96");
        }
    }

    private String stateText() {
        switch (state) {
            case STATE_WORKING:
                return note.isEmpty() ? "DSH 工作中" : "DSH 工作中 · " + note;
            case STATE_IDLE:
                return "DSH 空闲";
            case STATE_STOPPED:
                return "DSH 服务已停止";
            default:
                return "DSH 状态未知";
        }
    }

    private void applyShape() {
        if (root == null) return;
        int color = stateColor();
        if (expanded) {
            params.width = WindowManager.LayoutParams.WRAP_CONTENT;
            params.height = WindowManager.LayoutParams.WRAP_CONTENT;
            root.setGravity(Gravity.CENTER_VERTICAL);
            root.setPadding(dp(14), dp(9), dp(14), dp(9));
            GradientDrawable pill = new GradientDrawable();
            pill.setShape(GradientDrawable.RECTANGLE);
            pill.setCornerRadius(dp(24));
            pill.setColor(Color.parseColor("#EE15151C"));
            pill.setStroke(dp(1), Color.parseColor("#33FFFFFF"));
            root.setBackground(pill);
            statusDot.setVisibility(View.VISIBLE);
            label.setVisibility(View.VISIBLE);
            label.setText(stateText());
        } else {
            params.width = dp(ARC_W_DP);
            params.height = dp(ARC_H_DP);
            root.setGravity(Gravity.CENTER);
            root.setPadding(0, 0, 0, 0);
            statusDot.setVisibility(View.GONE);
            label.setVisibility(View.GONE);
            // The arc opens away from the screen edge it hugs.
            arc.setOpenToRight(side > 0);
            arc.setColor(color);
            root.setBackground(arc);
        }
        root.setElevation(dp(8));
    }

    private void render() {
        if (root == null) return;
        applyShape();
        if (statusDot != null) {
            GradientDrawable dotShape = new GradientDrawable();
            dotShape.setShape(GradientDrawable.OVAL);
            dotShape.setColor(stateColor());
            statusDot.setBackground(dotShape);
        }
        root.setAlpha(1f);
        handler.removeCallbacks(pulse);
        if (state == STATE_WORKING) handler.postDelayed(pulse, 700);
        place();
    }

    /**
     * A stroked arc segment — the hollow handle.
     *
     * The circle is not a semicircle: it spans {@link #ARC_SWEEP_DEG} degrees centred on the
     * innermost point, so the ink occupies only
     * {@code radius * (1 - cos(sweep / 2)) + stroke} across. The arc is centred in its view and
     * the whole view sits against the screen edge, which leaves the tips a couple of dp from the
     * edge — close enough to read as attached without being a solid semicircle.
     */
    private static final class ArcDrawable extends Drawable {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF oval = new RectF();
        private final int strokeWidth;
        private final int radius;
        private final int sweep;
        private boolean openToRight = true;

        ArcDrawable(int strokeWidth, int radius, int sweep) {
            this.strokeWidth = strokeWidth;
            this.radius = radius;
            this.sweep = sweep;
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(strokeWidth);
            paint.setStrokeCap(Paint.Cap.ROUND);
        }

        void setOpenToRight(boolean value) {
            openToRight = value;
        }

        void setColor(int color) {
            paint.setColor(color);
            invalidateSelf();
        }

        @Override
        public void draw(Canvas canvas) {
            float w = getBounds().width();
            float h = getBounds().height();
            float half = (float) Math.toRadians(sweep / 2.0);
            float inkWidth = radius * (1f - (float) Math.cos(half)) + strokeWidth;
            float margin = Math.max(0f, (w - inkWidth) / 2f);
            float cy = h / 2f;
            float cx;
            float start;
            if (openToRight) {
                // Innermost point on the left of the view; the screen edge is to the right.
                cx = margin + strokeWidth / 2f + radius;
                start = 180f - sweep / 2f;
            } else {
                cx = w - margin - strokeWidth / 2f - radius;
                start = -sweep / 2f;
            }
            oval.set(cx - radius, cy - radius, cx + radius, cy + radius);
            canvas.drawArc(oval, start, sweep, false, paint);
        }

        @Override
        public void setAlpha(int alpha) {
            paint.setAlpha(alpha);
            invalidateSelf();
        }

        @Override
        public void setColorFilter(ColorFilter filter) {
            paint.setColorFilter(filter);
            invalidateSelf();
        }

        @Override
        public int getOpacity() {
            return PixelFormat.TRANSLUCENT;
        }
    }

    // ------------------------------------------------------------------ geometry

    private int screenWidth() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                return windowManager.getCurrentWindowMetrics().getBounds().width();
            }
            DisplayMetrics metrics = new DisplayMetrics();
            windowManager.getDefaultDisplay().getRealMetrics(metrics);
            return metrics.widthPixels;
        } catch (Throwable t) {
            return context.getResources().getDisplayMetrics().widthPixels;
        }
    }

    private int screenHeight() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                return windowManager.getCurrentWindowMetrics().getBounds().height();
            }
            DisplayMetrics metrics = new DisplayMetrics();
            windowManager.getDefaultDisplay().getRealMetrics(metrics);
            return metrics.heightPixels;
        } catch (Throwable t) {
            return context.getResources().getDisplayMetrics().heightPixels;
        }
    }

    private int measuredWidth() {
        return root == null || root.getWidth() == 0 ? dp(ARC_W_DP) : root.getWidth();
    }

    private int maxY() {
        int h = root == null || root.getHeight() == 0 ? dp(ARC_H_DP) : root.getHeight();
        return Math.max(dp(8), screenHeight() - h - dp(8));
    }

    private int nearestSide() {
        if (snapped) return side;
        int centerX = params.x + measuredWidth() / 2;
        return centerX < (edgeLeft + edgeRight) / 2f ? -1 : 1;
    }

    /** Absolute left, whichever gravity is currently in force. */
    private int currentLeft() {
        boolean rightGravity = (params.gravity & Gravity.HORIZONTAL_GRAVITY_MASK) == Gravity.RIGHT;
        if (rightGravity) {
            int right = edgesMeasured ? edgeRight : screenWidth();
            return right - measuredWidth() - params.x;
        }
        return params.x;
    }

    private void place() {
        if (root == null) return;
        params.y = Math.max(dp(8), Math.min(params.y, maxY()));
        if (snapped) {
            // The window manager aligns the docked edge, so no measured size is involved.
            params.x = 0;
            params.gravity = side < 0 ? (Gravity.TOP | Gravity.START) : (Gravity.TOP | Gravity.END);
        } else {
            params.gravity = Gravity.TOP | Gravity.START;
            clampFree();
        }
        applyParams();
        applyGestureExclusion();
        if (snapped) {
            handler.removeCallbacks(calibrate);
            handler.postDelayed(calibrate, 120L);
        }
        persist();
    }

    /**
     * Keep a floating pill on screen, using its measured width.
     *
     * Only ever reached while no shape is changing, or one frame later via
     * {@link #placeAfterLayout()} — a fresh shape's width is not available yet.
     */
    private void clampFree() {
        int w = measuredWidth();
        int right = edgesMeasured ? edgeRight : screenWidth();
        int left = edgesMeasured ? edgeLeft : 0;
        params.x = Math.max(left, Math.min(params.x, Math.max(left, right - w)));
    }

    /**
     * Re-clamp after the layout that a shape change triggered.
     *
     * A pill appearing where an arc was is wider than {@code getWidth()} still reports, so the
     * first clamp is done against the wrong number. One pre-draw pass settles it.
     */
    private void placeAfterLayout() {
        if (root == null) return;
        root.getViewTreeObserver().addOnPreDrawListener(new ViewTreeObserver.OnPreDrawListener() {
            @Override
            public boolean onPreDraw() {
                if (root != null) {
                    ViewTreeObserver observer = root.getViewTreeObserver();
                    if (observer.isAlive()) observer.removeOnPreDrawListener(this);
                }
                if (!snapped) {
                    clampFree();
                    applyParams();
                }
                return true;
            }
        });
    }

    private void applyParams() {
        if (root == null) return;
        try {
            windowManager.updateViewLayout(root, params);
        } catch (Throwable ignored) {
            /* not attached */
        }
    }

    /**
     * Ask the system to stop claiming the handle's strip for the back gesture. Honoured from
     * API 29, and the platform caps the total excluded height per app — 56dp is well inside it.
     */
    private void applyGestureExclusion() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || root == null) return;
        int w = root.getWidth();
        int h = root.getHeight();
        if (w == 0 || h == 0) return;
        try {
            root.setSystemGestureExclusionRects(Collections.singletonList(new Rect(0, 0, w, h)));
        } catch (Throwable ignored) {
            /* best effort */
        }
    }

    private void persist() {
        prefs.edit()
                .putInt(KEY_X, snapped ? 0 : params.x)
                .putInt(KEY_Y, params.y)
                .putBoolean(KEY_SNAPPED, snapped)
                .putInt(KEY_SIDE, side)
                .apply();
    }

    /** Dock to an edge as the arc. */
    private void snapTo(int which) {
        snapped = true;
        expanded = false;
        side = which;
        handler.removeCallbacks(autoDock);
        applyShape();
        place();
    }

    /** Float free as the pill, keeping the vertical position. */
    private void floatFree(int which) {
        snapped = false;
        expanded = true;
        side = which;
        applyShape();
        place();
        // The pill is wider than the arc that was just showing, so re-clamp once laid out.
        placeAfterLayout();
        handler.removeCallbacks(autoDock);
        handler.postDelayed(autoDock, AUTO_DOCK_MS);
    }

    private int dp(int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }

    // ------------------------------------------------------------------ interaction

    private final class TouchHandler implements View.OnTouchListener {
        private float downRawX;
        private float downRawY;
        private int downX;
        private int downY;

        @Override
        public boolean onTouch(View v, MotionEvent event) {
            gestures.onTouchEvent(event);
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN: {
                    Diag.report("down snapped=" + snapped + " expanded=" + expanded + " x=" + params.x
                            + " y=" + params.y + " w=" + measuredWidth());
                    // A window that has been sitting still reports its real position reliably,
                    // so this is the best moment to re-measure the edges.
                    if (snapped) calibrate.run();
                    // Read the absolute position *before* normalising gravity: currentLeft()
                    // decides by reading params.gravity, so writing it first makes a right-docked
                    // handle report a left of 0 and teleport to the other edge.
                    int left = currentLeft();
                    params.gravity = Gravity.TOP | Gravity.START;
                    params.x = left;
                    downRawX = event.getRawX();
                    downRawY = event.getRawY();
                    downX = params.x;
                    downY = params.y;
                    return true;
                }
                case MotionEvent.ACTION_MOVE: {
                    lastRawX = event.getRawX();
                    float dx = event.getRawX() - downRawX;
                    float dy = event.getRawY() - downRawY;
                    if (!dragging
                            && (Math.abs(dx) > dp(DRAG_SLOP_DP) || Math.abs(dy) > dp(DRAG_SLOP_DP))) {
                        dragging = true;
                        handler.removeCallbacks(autoDock);
                    }
                    if (dragging) {
                        // Absolute screen coordinates: this window moves with the finger, so
                        // view-local deltas would feed back into themselves and stutter.
                        params.x = downX + Math.round(dx);
                        params.y = Math.max(dp(8), downY + Math.round(dy));
                        applyParams();
                    }
                    return true;
                }
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    if (dragging) {
                        dragging = false;
                        settle();
                    } else {
                        place();
                    }
                    return true;
                default:
                    return true;
            }
        }
    }

    /**
     * Dock if the *window* let go against an edge, otherwise stay a floating pill.
     *
     * The test is the window's own gap to the edge, not the finger's distance to it. Those are the
     * same thing for a narrow shape, which is why an earlier finger-based rule looked correct —
     * but the pill is ~350px wide, so pushing its edge onto the screen edge leaves the finger well
     * inside the screen and the snap never fired.
     */
    private void settle() {
        int zone = Math.max(dp(SNAP_DP), (edgeRight - edgeLeft) / 6);
        int edgesRight = edgesMeasured ? edgeRight : screenWidth();
        int edgesLeft = edgesMeasured ? edgeLeft : 0;
        int widthNow = measuredWidth();
        int leftGap = params.x - edgesLeft;
        int rightGap = edgesRight - (params.x + widthNow);
        int which;
        boolean dock;
        if (leftGap <= zone) {
            dock = true;
            which = -1;
        } else if (rightGap <= zone) {
            dock = true;
            which = 1;
        } else {
            dock = false;
            which = params.x + widthNow / 2f < (edgesLeft + edgesRight) / 2f ? -1 : 1;
        }
        Diag.report("up x=" + params.x + " w=" + widthNow + " L=" + edgesLeft + " R=" + edgesRight
                + " measured=" + edgesMeasured + " zone=" + zone + " leftGap=" + leftGap
                + " rightGap=" + rightGap + " raw=" + Math.round(lastRawX)
                + " => dock=" + dock + " side=" + which + " sw=" + screenWidth());
        if (dock) {
            snapTo(which);
        } else {
            floatFree(which);
        }
    }

    private final class TouchGestures extends GestureDetector.SimpleOnGestureListener {
        @Override
        public boolean onDown(MotionEvent e) {
            return true;
        }

        /** Fires only once the double-tap window has passed without a second tap. */
        @Override
        public boolean onSingleTapConfirmed(MotionEvent e) {
            if (snapped) {
                floatFree(side);
            } else {
                snapTo(nearestSide());
            }
            return true;
        }

        @Override
        public boolean onDoubleTap(MotionEvent e) {
            handler.removeCallbacks(autoDock);
            persist();
            if (onTap != null) onTap.run();
            return true;
        }
    }

    /** Last finger position in screen coordinates, reported for diagnostics only. */
    private float lastRawX;
}