package computer.imperfect.code

import android.content.Intent
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.Manifest
import android.content.pm.PackageManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.text.InputType
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AlertDialog
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import java.io.File

/**
 * One window onto the computer.
 *
 * The environment is the machine's own surface: imperfect, full screen, in
 * the computer's own theme. This activity does not draw a phone interface of its own on top of that, because a
 * second interface is a second product.
 *
 * The wrap adds file chooser and safe-area integration. External pages use
 * Android's installed browser; this app owns no browser surface or cookie jar.
 * Closing it stops nothing and uninstalling it takes no session, file or
 * transcript with it.
 */
class MainActivity : AppCompatActivity() {

  private lateinit var root: FrameLayout
  private lateinit var console: WebView
  private lateinit var status: TextView
  private lateinit var loading: Loading
  private lateinit var band: DownloadBand
  private var safeTopPx = 0
  private var safeBottomPx = 0
  private var fileCallback: ValueCallback<Array<Uri>>? = null
  // Whether the machine's page is up in the window, whether one is being
  // looked for, and whether the last load ended in an error.
  private var reached = false
  private var reaching = false
  private var failed = false
  private var photoTarget: Uri? = null
  private var machineForm: View? = null
  private var photoFile: File? = null
  // The page asked for the mic before Android had been asked: it waits here
  // for the answer.
  private var micRequest: PermissionRequest? = null
  private val askMic = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    val request = micRequest ?: return@registerForActivityResult
    micRequest = null
    if (granted) request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else request.deny()
  }
  // The plus on imperfect is a file input. A WebView will not open one unless
  // the wrap shows the phone's picker and hands the chosen files back.
  private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
    // A camera app answers with an empty result: it wrote to the file it was
    // given rather than handing one back. So a picture is recognised by the
    // file having bytes in it, not by the intent having a Uri.
    val handed = Attach.chosen(result.resultCode, result.data)
    val shot = photoTarget.takeIf {
      result.resultCode == RESULT_OK && (handed == null || handed.isEmpty()) && (photoFile?.length() ?: 0L) > 0L
    }
    fileCallback?.onReceiveValue(shot?.let { arrayOf(it) } ?: handed)
    fileCallback = null
    if (shot == null) photoFile?.delete()
    photoTarget = null
    photoFile = null
  }

  /**
   * Somewhere for the camera to put a picture. The machine is what keeps a
   * file; this is a scratch copy on the way there, in the cache so the phone
   * can reclaim it and uninstalling takes nothing with it.
   */
  private fun newPhotoTarget(): Uri? = try {
    val dir = File(cacheDir, "attachments").apply { mkdirs() }
    dir.listFiles()?.forEach { it.delete() }
    val file = File(dir, "photo-${System.currentTimeMillis()}.jpg")
    photoFile = file
    FileProvider.getUriForFile(this, "$packageName.attachments", file)
  } catch (_: Exception) {
    photoFile = null
    null
  }

  private inner class MachineChrome : Surfaces.Reporter("transported") {
    // Only the microphone, and only for the dock's mic; never the camera.
    override fun onPermissionRequest(request: PermissionRequest) {
      if (!request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) { request.deny(); return }
      if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
        request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        return
      }
      micRequest?.deny()
      micRequest = request
      askMic.launch(Manifest.permission.RECORD_AUDIO)
    }

    override fun onShowFileChooser(
      webView: WebView,
      filePathCallback: ValueCallback<Array<Uri>>,
      fileChooserParams: WebChromeClient.FileChooserParams,
    ): Boolean {
      fileCallback?.onReceiveValue(null)
      fileCallback = filePathCallback
      photoTarget = newPhotoTarget()
      return try {
        val choices = Attach.choices(this@MainActivity, fileChooserParams, photoTarget)
        AlertDialog.Builder(this@MainActivity)
          .setTitle(R.string.attach)
          .setItems(choices.map { getString(it.label) }.toTypedArray()) { _, which ->
            try { pickFiles.launch(choices[which].intent) }
            catch (_: Exception) { cancelFilePicker() }
          }
          .setNegativeButton(android.R.string.cancel) { _, _ -> cancelFilePicker() }
          .setOnCancelListener { cancelFilePicker() }
          .show().window?.setBackgroundDrawable(ColorDrawable(getColor(R.color.band)))
        true
      } catch (_: Exception) {
        cancelFilePicker()
        true
      }
    }
  }

  private fun cancelFilePicker() {
    fileCallback?.onReceiveValue(null)
    fileCallback = null
    photoFile?.delete()
    photoTarget = null
    photoFile = null
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    Machine.load(this)
    WindowCompat.setDecorFitsSystemWindows(window, false)
    hideSystemBars()

    root = FrameLayout(this)
    root.fitsSystemWindows = false
    root.setBackgroundColor(getColor(R.color.ground))
    ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
      val bars = insets.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.systemBars())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      safeTopPx = bars.top
      safeBottomPx = maxOf(bars.bottom, ime.bottom)
      paintSafeArea()
      if (::loading.isInitialized) loading.layoutParams = (loading.layoutParams as FrameLayout.LayoutParams).apply { topMargin = safeTopPx }
      if (::band.isInitialized) band.layoutParams = (band.layoutParams as FrameLayout.LayoutParams).apply { bottomMargin = safeBottomPx }
      // The page makes room for the keys itself (--safe-bottom). Told of them
      // too, the WebView shrank its visual viewport, and a swipe then lifted
      // the whole page by the keyboard's height over empty space.
      WindowInsetsCompat.Builder(insets).setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE).build()
    }

    status = TextView(this)
    status.gravity = Gravity.CENTER
    status.setTextColor(getColor(R.color.ink))
    status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    val pad = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 24f, resources.displayMetrics).toInt()
    status.setPadding(pad, pad, pad, pad)
    status.visibility = View.GONE
    root.addView(status, FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
    loading = Loading(this)
    root.addView(loading, FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 2f, resources.displayMetrics).toInt(),
      Gravity.TOP,
    ).apply { topMargin = safeTopPx })
    // A download from Files: how far it has come, then where it went, at the
    // foot of the window, clear of the gesture bar (Downloads.kt).
    band = DownloadBand(this)
    root.addView(band, FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM,
    ).apply { bottomMargin = safeBottomPx })
    Downloads.watch(this, band::show)

    setContentView(root)

    // A pairing link (the QR code from `./install.sh phone`) names a computer.
    // It is asked about, not switched to, so a stray link cannot move the phone.
    val offered = if (savedInstanceState == null) Machine.offered(intent) else null
    if (!Machine.configured() || (offered != null && offered != Machine.candidates.first())) {
      askForMachine(offered?.let { getString(R.string.offered_machine, it.removePrefix("https://")) } ?: getString(R.string.first_machine), offered.orEmpty())
      return
    }

    console = Surfaces.transported(
      this,
      onFailed = { failed = true; reached = false; loading.end(); say(getString(R.string.unreachable, hostLabel(), it)) },
      // A failed load finishes too; only a clean one counts as the page being up.
      onReady = { if (!failed) reached = true; failed = false; loading.end(); paintSafeArea() },
      // Its renderer was taken (the phone short of memory while the app was
      // away) or crashed: the window is made again, rather than going blank
      // or taking the app down with it.
      onGone = { reached = false; recreate() },
      chrome = MachineChrome(),
    )
    root.addView(console, 0, FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

    reach()

    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        // A pairing question over a page that is up: back keeps the page.
        machineForm?.takeIf { reached }?.let { root.removeView(it); machineForm = null; asking = false; return }
        if (console.canGoBack()) console.goBack()
        // Leaving is not stopping. The owner machine keeps working.
        else moveTaskToBack(true)
      }
    })
  }

  /**
   * Which machine is home is a question, not a constant, so it is asked before
   * the first page load rather than assumed. It is asked again whenever the
   * window comes back without a page: a phone unlocked away from the tailnet
   * should not keep saying so once it is home. A page that is up is left
   * alone; it reconnects its own socket the moment it is looked at.
   */
  private fun reach() {
    if (reached || reaching) return
    reaching = true
    loading.begin()
    say(getString(R.string.reaching, hostLabel()))
    Thread {
      val found = Machine.findHome()
      runOnUiThread {
        reaching = false
        if (!found) {
          loading.end()
          askForMachine(getString(R.string.unreachable, hostLabel(), getString(R.string.try_another)), Machine.base)
          return@runOnUiThread
        }
        status.visibility = View.GONE
        console.loadUrl(Machine.base + "/")
        Update.check(this)
      }
      if (found) Machine.learn(this)
    }.start()
  }

  // A pairing link while the app is open: the same question, over the page.
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    val offered = Machine.offered(intent) ?: return
    if (offered == Machine.base && reached) return
    askForMachine(getString(R.string.offered_machine, offered.removePrefix("https://")), offered)
  }

  override fun onStart() {
    super.onStart()
    if (::band.isInitialized) band.awake(true)
    // Back in front (the screen on again, the app brought back): if the
    // machine's page never arrived, look for the machine again.
    if (::console.isInitialized && !asking) reach()
    if (reached) resumePage()
    // A newer version of this app, from the machine.
    if (reached) Update.check(this)
  }

  override fun onStop() {
    watchdog.removeCallbacksAndMessages(null)
    if (::band.isInitialized) band.awake(false)
    super.onStop()
  }

  /**
   * Back in front with the page up. The page is told at once (harness.js,
   * imperfectResume) rather than left to notice: a WebView's page does not
   * always hear its app come back, and its sockets may have died with the
   * screen. The page checks them and marks what it shows stale until it is
   * current. A page that does not answer within a few seconds is stuck, its
   * renderer frozen, and is loaded again: what killing the app used to do.
   */
  private val watchdog = Handler(Looper.getMainLooper())
  private var resumeAsked = 0
  private fun resumePage() {
    val asked = ++resumeAsked
    var answered = false
    watchdog.postDelayed({
      if (!answered && asked == resumeAsked && reached) {
        loading.begin()
        console.reload()
      }
    }, RESUME_ANSWER_MS)
    console.evaluateJavascript("typeof imperfectResume === 'function' ? (imperfectResume(), 'resumed') : 'none'") { answered = true }
  }

  private fun say(message: String) {
    status.text = message
    status.visibility = View.VISIBLE
  }

  /**
   * The one question this app ever asks: which computer. It is asked in the
   * first run, when a pairing link names a computer (filled in, one tap), and
   * again when the remembered one cannot be reached; the answer is checked
   * (`/health` over Tailscale HTTPS) before it is kept. With nothing filled in
   * it leads with the camera: the QR code `./install.sh phone` shows. Typing
   * the address is the quieter way.
   */
  private var asking = false
  private fun askForMachine(message: String, prefill: String) {
    asking = true
    status.visibility = View.GONE
    machineForm?.let { root.removeView(it) }
    val dp = { value: Float -> TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, resources.displayMetrics).toInt() }
    val form = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(28f), dp(28f), dp(28f), dp(28f))
      // Opaque and touch-tight: it may be asked over a page that is up.
      setBackgroundColor(getColor(R.color.ground))
      isClickable = true
    }
    machineForm = form
    val note = TextView(this).apply {
      text = message
      setTextColor(getColor(R.color.ink))
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
      setLineSpacing(0f, 1.25f)
      setPadding(0, 0, 0, dp(20f))
    }
    val field = EditText(this).apply {
      hint = getString(R.string.machine_hint)
      setText(prefill.removePrefix("https://"))
      setTextColor(getColor(R.color.bright))
      setHintTextColor(getColor(R.color.muted))
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
      imeOptions = EditorInfo.IME_ACTION_GO
      isSingleLine = true
      background = GradientDrawable().apply {
        setColor(getColor(R.color.band))
        setStroke(dp(1f), getColor(R.color.rule))
      }
      setPadding(dp(16f), dp(16f), dp(16f), dp(16f))
    }
    val main = Button(this).apply {
      isAllCaps = false
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
      setTextColor(getColor(R.color.ground))
      background = GradientDrawable().apply {
        setColor(getColor(R.color.accent))
      }
      stateListAnimator = null
    }
    val other = Button(this).apply {
      isAllCaps = false
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
      setTextColor(getColor(R.color.accent))
      background = null
      stateListAnimator = null
    }
    form.addView(note)
    form.addView(field, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(14f) })
    form.addView(main, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(54f)))
    form.addView(other, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48f)).apply { topMargin = dp(6f) })
    root.addView(form, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

    val typing = { field.visibility == View.VISIBLE }
    fun showField(on: Boolean) {
      field.visibility = if (on) View.VISIBLE else View.GONE
      main.text = getString(if (on) R.string.connect else R.string.scan)
      other.text = getString(if (on) R.string.scan_instead else R.string.type_instead)
    }

    fun submit() {
      val address = Machine.origin(field.text.toString())
      if (address == null) {
        note.text = getString(R.string.machine_invalid)
        return
      }
      main.isEnabled = false
      note.text = getString(R.string.reaching, address.removePrefix("https://"))
      Thread {
        val ok = Machine.answers(address)
        runOnUiThread {
          main.isEnabled = true
          if (!ok) {
            note.text = getString(R.string.unreachable, address.removePrefix("https://"), getString(R.string.try_another))
            return@runOnUiThread
          }
          Machine.remember(this, address)
          recreate()
        }
      }.start()
    }

    // Google Play services draws the camera itself and hands back the code;
    // this app asks for no camera permission.
    fun scan() {
      val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
      GmsBarcodeScanning.getClient(this, options).startScan()
        .addOnSuccessListener { code ->
          val address = Machine.origin(code.rawValue.orEmpty())
          if (address == null) { note.text = getString(R.string.scan_not_address); return@addOnSuccessListener }
          field.setText(address.removePrefix("https://"))
          showField(true)
          submit()
        }
        .addOnFailureListener { note.text = getString(R.string.scan_unavailable) }
    }

    main.setOnClickListener { if (typing()) submit() else scan() }
    other.setOnClickListener {
      if (typing()) scan()
      else {
        showField(true)
        field.requestFocus()
        getSystemService(InputMethodManager::class.java)?.showSoftInput(field, InputMethodManager.SHOW_IMPLICIT)
      }
    }
    field.setOnEditorActionListener { _, action, _ -> if (action == EditorInfo.IME_ACTION_GO) { submit(); true } else false }
    showField(prefill.isNotEmpty())
  }

  private fun hostLabel(): String =
    Machine.candidates.joinToString(" or ") { it.removePrefix("https://").removePrefix("http://") }

  companion object {
    // How long a page that is up has to answer being told the app is back.
    const val RESUME_ANSWER_MS = 4000L
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) hideSystemBars()
  }

  private fun hideSystemBars() {
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    controller.hide(WindowInsetsCompat.Type.statusBars() or WindowInsetsCompat.Type.navigationBars())
  }

  // The page keeps its work clear of the status bar and the gesture bar or
  // buttons, and fills the strips they take with the bars' dust.
  private fun paintSafeArea() {
    if (!::console.isInitialized) return
    val density = resources.displayMetrics.density
    if (density <= 0f) return
    val top = safeTopPx / density
    val bottom = safeBottomPx / density
    val js = "document.documentElement.style.setProperty('--safe-top','${top}px');document.documentElement.style.setProperty('--safe-bottom','${bottom}px');"
    console.evaluateJavascript(js, null)
  }

  override fun onDestroy() {
    watchdog.removeCallbacksAndMessages(null)
    Downloads.unwatch(this)
    fileCallback?.onReceiveValue(null)
    fileCallback = null
    if (::console.isInitialized) console.destroy()
    super.onDestroy()
  }
}
