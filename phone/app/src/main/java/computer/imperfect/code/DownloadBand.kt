package computer.imperfect.code

import android.content.Context
import android.text.TextUtils
import android.text.format.Formatter
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * A download from Files (Downloads.kt), at the foot of the window: how far it
 * has come, with Cancel, then "Saved to Downloads" and Open, or what went
 * wrong. A band in the app's own Black with hard edges, the accent line
 * along its top filling as the file comes in. What finished stays a few
 * seconds while the window is in front, so one that finished while the
 * person was away is still there when they come back.
 */
class DownloadBand(context: Context) : FrameLayout(context) {
  private val line = TextView(context)
  private val action = TextView(context)
  private val bar = View(context)
  private var state: Downloads.State? = null
  private var awake = true
  private val hide = Runnable { visibility = View.GONE }

  init {
    visibility = View.GONE
    setBackgroundColor(context.getColor(R.color.band))
    // Its touches are its own, never the page's under it.
    isClickable = true
    accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    line.apply {
      setTextColor(context.getColor(R.color.ink))
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
      isSingleLine = true
      ellipsize = TextUtils.TruncateAt.MIDDLE
    }
    action.apply {
      setTextColor(context.getColor(R.color.accent))
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
      gravity = Gravity.CENTER
      setPadding(dp(14f), 0, dp(14f), 0)
      isClickable = true
    }
    val row = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(16f), dp(6f), dp(4f), dp(6f))
      addView(line, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
      addView(action, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(44f)))
    }
    addView(row, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(View(context).apply { setBackgroundColor(context.getColor(R.color.rule)) },
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1f), Gravity.TOP))
    bar.setBackgroundColor(context.getColor(R.color.accent))
    bar.pivotX = 0f
    addView(bar, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(2f), Gravity.TOP))
  }

  fun show(now: Downloads.State) {
    state = now
    removeCallbacks(hide)
    visibility = View.VISIBLE
    when (now) {
      is Downloads.State.Going -> {
        val size = { bytes: Long -> Formatter.formatShortFileSize(context, bytes) }
        val far = if (now.total > 0) context.getString(R.string.download_part, (now.done * 100 / now.total).toInt(), size(now.total))
          else size(now.done)
        val said = context.getString(R.string.download_going, now.name, far)
        line.text = if (now.waiting > 0) context.getString(R.string.download_more, said, now.waiting) else said
        // How far, along the top; one of no known size, a dim line whole.
        bar.visibility = View.VISIBLE
        bar.alpha = if (now.total > 0) 1f else 0.35f
        bar.scaleX = if (now.total > 0) (now.done.toFloat() / now.total).coerceIn(0f, 1f) else 1f
        offer(context.getString(R.string.download_cancel)) { Downloads.stop() }
        setOnClickListener(null)
      }
      is Downloads.State.Saved -> {
        line.text = context.getString(R.string.download_saved, now.name)
        bar.visibility = View.GONE
        val open = { Downloads.open(context, now); visibility = View.GONE }
        offer(context.getString(R.string.download_open), open)
        setOnClickListener { open() }
        later()
      }
      is Downloads.State.Failed -> {
        line.text = context.getString(R.string.download_failed, now.name, now.why)
        bar.visibility = View.GONE
        action.visibility = View.GONE
        setOnClickListener { visibility = View.GONE }
        later()
      }
    }
  }

  /** The window in front or not: what finished waits to be seen. */
  fun awake(on: Boolean) {
    awake = on
    removeCallbacks(hide)
    if (on && visibility == View.VISIBLE && state !is Downloads.State.Going) later()
  }

  private fun offer(label: String, run: () -> Unit) {
    action.text = label
    action.visibility = View.VISIBLE
    action.setOnClickListener { run() }
  }

  private fun later() { if (awake) postDelayed(hide, SHOWN_MS) }

  private fun dp(value: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, resources.displayMetrics).toInt()

  companion object {
    // How long "Saved to Downloads" stays, once seen.
    const val SHOWN_MS = 8000L
  }
}
