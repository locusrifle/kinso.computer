package computer.imperfect.code

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.content.Context
import android.view.View
import android.view.ViewGroup
import android.view.animation.AccelerateDecelerateInterpolator
import android.widget.FrameLayout

/**
 * The one loading mark, as the page draws it (public/css/loading.css): a thin
 * bar along the top edge in the accent, a segment running across it, hard
 * edges, no spinner. It shows only once something has been loading for
 * DELAY_MS, so what is quick never flickers it. The app holds it while it
 * looks for the computer and loads its page; from then on the page has its own.
 */
class Loading(context: Context) : FrameLayout(context) {
  private val segment = View(context).apply { setBackgroundColor(context.getColor(R.color.accent)) }
  private var running: ObjectAnimator? = null
  private val show = Runnable {
    visibility = View.VISIBLE
    sweep()
  }

  init {
    visibility = View.GONE
    isClickable = false
    addView(segment, FrameLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT))
  }

  fun begin() {
    if (visibility == View.VISIBLE) return
    removeCallbacks(show)
    postDelayed(show, DELAY_MS)
  }

  fun end() {
    removeCallbacks(show)
    running?.cancel()
    running = null
    visibility = View.GONE
  }

  private fun sweep() {
    val across = (if (width > 0) width else resources.displayMetrics.widthPixels).toFloat()
    val part = (across * 0.3f).toInt()
    segment.layoutParams = FrameLayout.LayoutParams(part, ViewGroup.LayoutParams.MATCH_PARENT)
    running?.cancel()
    running = ObjectAnimator.ofFloat(segment, "translationX", -part.toFloat(), across).apply {
      duration = 1100
      repeatCount = ValueAnimator.INFINITE
      interpolator = AccelerateDecelerateInterpolator()
      start()
    }
  }

  companion object {
    const val DELAY_MS = 150L
  }
}
