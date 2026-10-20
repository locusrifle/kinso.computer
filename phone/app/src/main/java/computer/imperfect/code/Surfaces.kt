package computer.imperfect.code

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.view.MotionEvent
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebViewClient

/**
 * A transported imperfect/Files surface keeps nothing on the phone. Its state is
 * the selected owner machine's. External pages are opened by Android in the
 * installed OS browser, preserving its normal cookies and OAuth behaviour.
 */
object Surfaces {

  /** What the page says went wrong, in logcat, where a phone can be debugged. */
  open class Reporter(private val tag: String) : WebChromeClient() {
    override fun onConsoleMessage(message: ConsoleMessage): Boolean {
      android.util.Log.i("imperfect", "$tag ${message.messageLevel()} ${message.message()} @${message.sourceId()}:${message.lineNumber()}")
      return true
    }
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun common(view: WebView) {
    view.settings.javaScriptEnabled = true
    view.settings.mediaPlaybackRequiresUserGesture = false
    view.settings.useWideViewPort = true
    view.settings.loadWithOverviewMode = false
    view.settings.setSupportZoom(false)
    view.setBackgroundColor(0)
    view.addJavascriptInterface(Native(view.context.applicationContext), "imperfectNative")
  }

  /**
   * The page's one way into the phone. A tap on a control asks for a click of
   * the vibration motor (site.js): the web's own navigator.vibrate does not
   * reach the motor from inside an app's WebView.
   */
  class Native(private val context: Context) {
    private val motor = context.getSystemService(Vibrator::class.java)
    @JavascriptInterface
    fun tick() {
      val motor = motor ?: return
      if (!motor.hasVibrator()) return
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) motor.vibrate(VibrationEffect.createPredefined(VibrationEffect.EFFECT_CLICK))
      else motor.vibrate(VibrationEffect.createOneShot(12, VibrationEffect.DEFAULT_AMPLITUDE))
    }
  }

  // A Files iframe eats page touches. The wrap still sees the fingers, so a
  // pinch here can ask the page for the overview even when one app fills it.
  private fun attachPinch(view: WebView) {
    var startSpread = 0f
    var fingers = 0
    view.setOnTouchListener { _, event ->
      val n = event.pointerCount
      when (event.actionMasked) {
        MotionEvent.ACTION_POINTER_DOWN -> {
          if (n == 2 || n == 3) {
            fingers = n
            startSpread = pinchSpread(event)
          }
        }
        MotionEvent.ACTION_MOVE -> {
          if (startSpread > 48f && n == fingers && (n == 2 || n == 3) && pinchSpread(event) <= startSpread * 0.85f) {
            val count = fingers
            startSpread = 0f
            fingers = 0
            view.evaluateJavascript("dispatchEvent(new CustomEvent('imperfect-pinch',{detail:{fingers:$count}}))", null)
          }
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL, MotionEvent.ACTION_POINTER_UP -> {
          if (n < 2) {
            startSpread = 0f
            fingers = 0
          }
        }
      }
      false
    }
  }

  private fun pinchSpread(event: MotionEvent): Float {
    val count = event.pointerCount
    if (count < 2) return 0f
    var cx = 0f
    var cy = 0f
    for (i in 0 until count) {
      cx += event.getX(i)
      cy += event.getY(i)
    }
    cx /= count
    cy /= count
    var total = 0f
    for (i in 0 until count) {
      val dx = event.getX(i) - cx
      val dy = event.getY(i) - cy
      total += kotlin.math.hypot(dx, dy)
    }
    return total / count
  }

  /** A face of the machine, moulded to the phone and held nowhere else. */
  fun transported(
    context: Context,
    onFailed: (String) -> Unit = {},
    onReady: () -> Unit = {},
    onGone: () -> Unit = {},
    chrome: WebChromeClient = Reporter("transported"),
  ): WebView {
    val view = WebView(context)
    common(view)
    attachPinch(view)
    // The pages agents show keep their saves here, as on a computer: a game
    // played on the phone remembers its stars. Each is on its own computer's
    // page origin (system/shown.mjs); sessions and files stay on the computers.
    view.settings.domStorageEnabled = true
    view.webChromeClient = chrome
    view.settings.cacheMode = WebSettings.LOAD_NO_CACHE
    // A download the page asks for (Download in Files): saved to the phone's
    // Downloads by the app (Downloads.kt). A WebView does nothing with one
    // unless it is handed on.
    view.setDownloadListener { url, userAgent, contentDisposition, _, _ ->
      Downloads.ask(context, url, userAgent, contentDisposition)
    }
    // Navigation among configured owner machines stays transported. Anything
    // else belongs to Android's installed browser; this shell does not create
    // an embedded browser or another cookie store.
    view.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url.toString()
        if (Machine.owns(url)) return false
        return try {
          context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
          true
        } catch (_: Exception) {
          true
        }
      }
      // A machine that cannot be reached is a sentence, not a spinner.
      override fun onPageFinished(view: WebView, url: String) {
        onReady()
      }
      override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (request.isForMainFrame) onFailed(error.description?.toString() ?: "")
      }
      // Unanswered, a renderer that dies takes the app with it. This view is
      // finished either way; onGone makes another.
      override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        onGone()
        return true
      }
    }
    return view
  }

}
