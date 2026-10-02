package dev.litedoc.viewer

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toolbar
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import dev.litedoc.viewer.export.ExportCoordinator
import dev.litedoc.viewer.settings.ViewerSettings
import dev.litedoc.viewer.storage.AttachmentRoot
import dev.litedoc.viewer.util.Redact
import dev.litedoc.viewer.web.BridgeUiActions
import dev.litedoc.viewer.web.LocalAssetRouter
import dev.litedoc.viewer.web.ViewerMessageBridge
import dev.litedoc.viewer.web.ViewerWebViewClient
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * The single reading screen.
 *
 * * the trusted shell is the only page that is ever loaded; every navigation away
 *   from it is cancelled and turned into a "copy link" action;
 * * document switching reloads the shell so no DOM, observer, worker or pending
 *   promise from the previous document can survive;
 * * a print job freezes the session until the platform adapter reports
 *   completion; new intents are queued meanwhile.
 */
class ViewerActivity : Activity(), ViewerMessageBridge.Host, BridgeUiActions {

    private lateinit var app: LiteDocApp
    private lateinit var viewer: ViewerViewModel
    private lateinit var rootView: LinearLayout
    private lateinit var toolbar: Toolbar
    private lateinit var webView: WebView
    private lateinit var statusPanel: View
    private lateinit var statusText: TextView
    private lateinit var errorPanel: View
    private lateinit var errorTitle: TextView
    private lateinit var errorMessage: TextView
    private lateinit var noticePanel: View
    private lateinit var noticeText: TextView
    private lateinit var searchBar: View
    private lateinit var searchInput: EditText
    private lateinit var searchCount: TextView
    private lateinit var documentBar: View
    private lateinit var documentList: LinearLayout

    private lateinit var bridge: ViewerMessageBridge
    private lateinit var router: LocalAssetRouter
    private lateinit var export: ExportCoordinator

    private val uiScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var stateJob: Job? = null
    private var shellLoadedFor: String? = null
    private var rendererAvailable = true
    private var pendingIntents = ArrayList<Intent>()
    private var lastState: ViewerViewModel.UiState = ViewerViewModel.UiState()
    private var noticeHideJob: Job? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        app = application as LiteDocApp
        viewer = app.viewer

        rootView = layoutInflater.inflate(R.layout.viewer, null) as LinearLayout
        setContentView(rootView)
        buildToolbar()
        applyEdgeToEdgeInsets()

        statusPanel = findViewById(R.id.status_panel)
        statusText = findViewById(R.id.status_text)
        errorPanel = findViewById(R.id.error_panel)
        errorTitle = findViewById(R.id.error_title)
        errorMessage = findViewById(R.id.error_message)
        noticePanel = findViewById(R.id.notice_panel)
        noticeText = findViewById(R.id.notice_text)
        searchBar = findViewById(R.id.search_bar)
        searchInput = findViewById(R.id.search_input)
        searchCount = findViewById(R.id.search_count)
        documentBar = findViewById(R.id.document_bar)
        documentList = findViewById(R.id.document_list)
        webView = findViewById(R.id.web_view)
        findViewById<Button>(R.id.error_close).setOnClickListener { finish() }
        findViewById<Button>(R.id.search_close).setOnClickListener { closeSearch() }
        findViewById<Button>(R.id.search_next).setOnClickListener {
            webView.findNext(true)
        }
        findViewById<Button>(R.id.search_prev).setOnClickListener {
            webView.findNext(false)
        }
        searchInput.setOnEditorActionListener { _, actionId, event ->
            val enter = event?.keyCode == KeyEvent.KEYCODE_ENTER &&
                event.action == KeyEvent.ACTION_DOWN
            if (actionId == EditorInfo.IME_ACTION_SEARCH || enter) {
                startSearch(searchInput.text.toString())
                true
            } else {
                false
            }
        }

        bridge = ViewerMessageBridge(this)
        router = LocalAssetRouter(this, viewer)
        export = ExportCoordinator(
            context = this,
            onStateChanged = { state, detail -> onExportState(state, detail) },
            onTargetReady = { exportId, kind, _ ->
                pushToPage(
                    "exportTargetReady",
                    JSONObject().put("exportId", exportId).put("kind", kind),
                )
            },
            onTargetCancelled = { kind ->
                pushToPage("exportFailed", JSONObject().put("kind", kind).put("reason", "cancelled"))
            },
        )

        configureWebView()
        rendererAvailable = bridge.attach(webView)
        if (!rendererAvailable) {
            viewer.announce(getString(R.string.error_webview_unsupported))
        }

        registerBackCallback()

        stateJob = uiScope.launch {
            viewer.state.collect { state -> onState(state) }
        }

        if (savedInstanceState == null) {
            viewer.submit(intent)
        }
    }

    // ------------------------------------------------------------------ web view

    private fun configureWebView() {
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = false
            databaseEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(false)
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mediaPlaybackRequiresUserGesture = true
            loadsImagesAutomatically = true
            blockNetworkLoads = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            builtInZoomControls = false
            displayZoomControls = false
            setSupportZoom(true)
            textZoom = (100 * app.settings.fontScale.scale).toInt()
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(false)
            setAcceptThirdPartyCookies(webView, false)
        }
        webView.isVerticalScrollBarEnabled = true
        webView.webChromeClient = WebChromeClient()
        webView.webViewClient = ViewerWebViewClient(
            router = router,
            onBlockedNavigation = { url -> onBlockedNavigation(url) },
            onMainFrameError = { _, code, description ->
                Redact.w("shell failed to load: code=$code detail=${description.take(120)}")
                viewer.announce(getString(R.string.error_engine_failed))
                loadSourceFallback()
            },
            onRenderProcessGone = { crashed ->
                Redact.w("render process gone (crashed=$crashed)")
                viewer.announce(getString(R.string.error_engine_failed))
                rendererAvailable = false
                loadSourceFallback()
            },
        )
        webView.setFindListener { ordinal, matches, done ->
            if (!done) return@setFindListener
            searchCount.text = if (matches == 0) {
                getString(R.string.search_none)
            } else {
                getString(R.string.search_count, ordinal, matches)
            }
        }
    }

    private fun loadSourceFallback() {
        val sessionId = lastState.sessionId ?: return
        shellLoadedFor = null
        webView.loadUrl(LocalAssetRouter.sourceUrl(sessionId))
    }

    private fun onBlockedNavigation(url: String) {
        Redact.d("blocked navigation to an outside URL")
        if (url.startsWith("http://") || url.startsWith("https://")) {
            copyToClipboard(url)
            viewer.announce(getString(R.string.link_copied))
        }
    }

    private fun copyToClipboard(text: String) {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as? android.content.ClipboardManager
            ?: return
        runCatching {
            clipboard.setPrimaryClip(android.content.ClipData.newPlainText("LiteDoc", text))
        }
    }

    // ------------------------------------------------------------------ state

    private fun onState(state: ViewerViewModel.UiState) {
        lastState = state
        applyPalette()
        toolbar.title = state.displayName ?: getString(R.string.app_name)
        toolbar.subtitle = null

        statusPanel.visibility = if (state.phase == ViewerViewModel.Phase.LOADING) View.VISIBLE else View.GONE
        statusText.text = when {
            state.phase == ViewerViewModel.Phase.LOADING && state.sessionId == null ->
                getString(R.string.state_loading)
            else -> getString(R.string.state_preparing)
        }

        if (state.phase == ViewerViewModel.Phase.ERROR && state.error != null) {
            errorPanel.visibility = View.VISIBLE
            errorTitle.text = getString(R.string.error_title)
            errorMessage.text = state.error
        } else {
            errorPanel.visibility = View.GONE
        }

        if (state.notice != null) {
            noticePanel.visibility = View.VISIBLE
            noticeText.text = state.notice
            noticeHideJob?.cancel()
            noticeHideJob = uiScope.launch {
                kotlinx.coroutines.delay(4000)
                noticePanel.visibility = View.GONE
                viewer.clearNotice()
            }
        } else {
            noticePanel.visibility = View.GONE
        }

        rebuildDocumentBar(state)

        if (state.phase == ViewerViewModel.Phase.READY && state.sessionId != null) {
            if (shellLoadedFor != state.sessionId) {
                shellLoadedFor = state.sessionId
                if (rendererAvailable) {
                    webView.stopLoading()
                    webView.loadUrl(LocalAssetRouter.SHELL_URL)
                } else {
                    loadSourceFallback()
                }
            }
        }
    }

    private fun rebuildDocumentBar(state: ViewerViewModel.UiState) {
        if (state.labels.size <= 1) {
            documentBar.visibility = View.GONE
            return
        }
        documentBar.visibility = View.VISIBLE
        documentList.removeAllViews()
        state.labels.forEachIndexed { index, label ->
            val button = Button(this)
            button.text = label
            button.isAllCaps = false
            button.maxLines = 1
            button.textSize = 13f
            button.alpha = if (index == state.index) 1.0f else 0.6f
            button.setOnClickListener { viewer.openIndex(index) }
            documentList.addView(button)
        }
    }

    private fun applyPalette() {
        val palette = currentPalette()
        rootView.setBackgroundColor(palette.window)
        webView.setBackgroundColor(palette.window)
        statusPanel.setBackgroundColor(palette.window)
        errorPanel.setBackgroundColor(palette.window)
        toolbar.setBackgroundColor(palette.toolbar)
        toolbar.setTitleTextColor(palette.foreground)
        searchBar.setBackgroundColor(palette.toolbar)
        searchCount.setTextColor(palette.foreground)
        noticeText.setTextColor(palette.foreground)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            window.statusBarColor = palette.toolbar
            window.navigationBarColor = palette.window
        }
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = !palette.dark
        controller.isAppearanceLightNavigationBars = !palette.dark
        val background = documentBar
        background.setBackgroundColor(palette.toolbar)
    }

    /**
     * targetSdk 35+ enforces edge-to-edge, so the reading surface pads itself by
     * the system bars and the display cutout instead of relying on a status bar
     * colour that the platform now ignores.
     */
    private fun applyEdgeToEdgeInsets() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        ViewCompat.setOnApplyWindowInsetsListener(rootView) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        ViewCompat.requestApplyInsets(rootView)
    }

    private fun currentPalette(): ViewerPalette {
        val mode = app.settings.themeMode
        val systemDark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES
        return when (mode) {
            ViewerSettings.ThemeMode.LIGHT -> ViewerPalette.LIGHT
            ViewerSettings.ThemeMode.DARK -> ViewerPalette.DARK
            ViewerSettings.ThemeMode.SYSTEM -> ViewerPalette.forDark(systemDark)
        }
    }

    private fun buildToolbar() {
        val palette = currentPalette()
        val existing = rootView.getChildAt(0)
        if (existing is Toolbar) rootView.removeViewAt(0)
        val toolbarContext = android.view.ContextThemeWrapper(
            this,
            if (palette.dark) R.style.Theme_LiteDoc_Toolbar_Dark else R.style.Theme_LiteDoc_Toolbar,
        )
        val bar = Toolbar(toolbarContext)
        bar.layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        bar.minimumHeight = (resources.displayMetrics.density * 52).toInt()
        bar.setNavigationIcon(R.drawable.ic_arrow_back)
        bar.setNavigationContentDescription(R.string.toolbar_back)
        bar.setNavigationOnClickListener { onBackPressed() }
        bar.inflateMenu(R.menu.viewer)
        bar.menu.findItem(R.id.action_wrap)?.isChecked = app.settings.wrapText
        bar.setOnMenuItemClickListener { item -> handleMenu(item.itemId) }
        rootView.addView(bar, 0)
        toolbar = bar
    }

    private fun handleMenu(itemId: Int): Boolean {
        when (itemId) {
            R.id.action_search -> openSearch()
            R.id.action_toc -> pushToPage("showToc", JSONObject())
            R.id.action_font -> showFontDialog()
            R.id.action_theme -> showThemeDialog()
            R.id.action_wrap -> {
                app.settings.wrapText = !app.settings.wrapText
                toolbar.menu.findItem(R.id.action_wrap).isChecked = app.settings.wrapText
                pushPreference("wrap", app.settings.wrapText.toString())
            }
            R.id.action_source -> pushToPage("requestSourceMode", JSONObject())
            R.id.action_copy -> pushToPage("copyAll", JSONObject())
            R.id.action_folder -> requestFolderGrant()
            R.id.action_images -> showImagesDialog()
            R.id.action_export -> showExportDialog()
            R.id.action_about -> showAboutDialog()
            R.id.action_close -> {
                viewer.closeCurrent()
                finish()
            }
            else -> return false
        }
        return true
    }

    // ------------------------------------------------------------------ search

    private fun openSearch() {
        searchBar.visibility = View.VISIBLE
        searchInput.requestFocus()
        val text = searchInput.text?.toString().orEmpty()
        if (text.isNotEmpty()) startSearch(text)
    }

    private fun startSearch(text: String) {
        if (text.isEmpty()) {
            webView.clearMatches()
            searchCount.text = ""
            return
        }
        webView.findAllAsync(text)
    }

    private fun closeSearch() {
        webView.clearMatches()
        searchBar.visibility = View.GONE
        searchInput.setText("")
        searchCount.text = ""
    }

    // ------------------------------------------------------------------ dialogs

    private fun showFontDialog() {
        val options = arrayOf(
            getString(R.string.font_small),
            getString(R.string.font_normal),
            getString(R.string.font_large),
            getString(R.string.font_huge),
        )
        val scales = ViewerSettings.FontScale.entries
        val checked = scales.indexOf(app.settings.fontScale).coerceAtLeast(0)
        AlertDialog.Builder(this)
            .setTitle(R.string.font_size_title)
            .setSingleChoiceItems(options, checked) { dialog, which ->
                val scale = scales.getOrNull(which) ?: ViewerSettings.FontScale.NORMAL
                app.settings.fontScale = scale
                webView.settings.textZoom = (100 * scale.scale).toInt()
                pushPreference("fontScale", scale.id)
                dialog.dismiss()
            }
            .show()
    }

    private fun showThemeDialog() {
        val options = arrayOf(
            getString(R.string.theme_system),
            getString(R.string.theme_light),
            getString(R.string.theme_dark),
        )
        val modes = listOf(
            ViewerSettings.ThemeMode.SYSTEM,
            ViewerSettings.ThemeMode.LIGHT,
            ViewerSettings.ThemeMode.DARK,
        )
        val checked = modes.indexOf(app.settings.themeMode).coerceAtLeast(0)
        AlertDialog.Builder(this)
            .setTitle(R.string.menu_theme)
            .setSingleChoiceItems(options, checked) { dialog, which ->
                val mode = modes.getOrNull(which) ?: ViewerSettings.ThemeMode.SYSTEM
                app.settings.themeMode = mode
                buildToolbar()
                applyPalette()
                pushPreference("theme", mode.id)
                dialog.dismiss()
            }
            .show()
    }

    private fun showImagesDialog() {
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 16, 32, 16)
        }
        val enable = CheckBox(this).apply {
            setText(R.string.images_enabled)
            isChecked = app.settings.remoteImagesEnabled
        }
        val lan = CheckBox(this).apply {
            setText(R.string.images_lan)
            isChecked = app.settings.allowLanImages
            isEnabled = app.settings.remoteImagesEnabled
        }
        enable.setOnCheckedChangeListener { _, checked ->
            app.settings.remoteImagesEnabled = checked
            lan.isEnabled = checked
            pushPreference("remoteImages", checked.toString())
        }
        lan.setOnCheckedChangeListener { _, checked ->
            app.settings.allowLanImages = checked
            pushPreference("allowLan", checked.toString())
        }
        val clear = Button(this).apply {
            setText(R.string.images_clear_cache)
            setOnClickListener {
                val freed = viewer.clearImageCache()
                viewer.announce(
                    getString(
                        R.string.images_cache_cleared,
                        "${freed / (1024 * 1024)} MiB",
                    ),
                )
            }
        }
        container.addView(enable)
        container.addView(lan)
        container.addView(clear)
        AlertDialog.Builder(this)
            .setTitle(R.string.images_title)
            .setView(container)
            .setPositiveButton(android.R.string.ok, null)
            .show()
    }

    private fun showExportDialog() {
        val options = arrayOf(
            getString(R.string.export_pdf),
            "导出图形为 SVG",
            "导出图形为 PNG",
            "导出原始文件",
        )
        AlertDialog.Builder(this)
            .setTitle(R.string.export_title)
            .setItems(options) { _, which ->
                when (which) {
                    0 -> pushToPage("exportPrepare", JSONObject().put("kind", "pdf"))
                    1 -> pushToPage("exportPrepare", JSONObject().put("kind", "svg"))
                    2 -> pushToPage("exportPrepare", JSONObject().put("kind", "png"))
                    3 -> exportOriginalFile()
                }
            }
            .show()
    }

    private fun exportOriginalFile() {
        val session = viewer.currentSession() ?: return
        export.requestTarget(
            this,
            kind = "source",
            mime = "application/octet-stream",
            suggestedName = viewer.suggestExportName("txt"),
            requestCode = REQ_EXPORT,
        )
        sourceExportSessionId = session.id
    }

    private var sourceExportSessionId: String? = null

    private fun showAboutDialog() {
        val version = BuildConfig.VERSION_NAME
        val notices = readAssetText("THIRD_PARTY_NOTICES.txt")
        val message = buildString {
            append("LiteDoc ").append(version).append('\n')
            append("applicationId dev.litedoc.viewer\n")
            append("targetSdk ").append(applicationInfo.targetSdkVersion).append('\n')
            append("WebView ").append(webViewVersion()).append('\n')
            append("built-in renderers: markdown-it, MathJax + mhchem, mermaid, " +
                "smiles-drawer, highlight.js, PapaParse, DOMPurify, css-tree\n\n")
            append(notices)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.about_title)
            .setMessage(message)
            .setPositiveButton(R.string.about_close, null)
            .show()
    }

    private fun webViewVersion(): String = runCatching {
        val packageInfo = android.webkit.WebView.getCurrentWebViewPackage()
        if (packageInfo == null) {
            "unknown"
        } else {
            "${packageInfo.packageName} ${packageInfo.versionName}"
        }
    }.getOrDefault("unknown")

    private fun readAssetText(name: String): String = runCatching {
        assets.open(name).use { it.readBytes().toString(Charsets.UTF_8) }
    }.getOrElse { "第三方许可清单未随构建内嵌：$name" }

    // ------------------------------------------------------------------ folder grant

    private fun requestFolderGrant() {
        if (lastState.sessionId == null) {
            viewer.announce(getString(R.string.error_no_document))
            return
        }
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            addFlags(Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
        }
        try {
            startActivityForResult(intent, REQ_FOLDER_TREE)
        } catch (_: Exception) {
            viewer.announce(getString(R.string.folder_grant_failed))
        }
    }

    private fun onFolderTreePicked(uri: Uri) {
        val persisted = viewer.takePersistable(uri)
        if (!persisted) {
            viewer.announce(getString(R.string.folder_grant_failed))
        }
        val tree = viewer.treeOf(uri)
        if (tree == null) {
            viewer.announce(getString(R.string.folder_grant_failed))
            return
        }
        val sessionUri = viewer.currentSession()?.originUri?.let { runCatching { Uri.parse(it) }.getOrNull() }
        val segments = sessionUri?.let { viewer.segmentsFor(tree, it) }
        if (segments != null) {
            viewer.setAttachmentRoot(
                AttachmentRoot(
                    treeUri = tree.uri,
                    rootDocumentId = tree.rootDocumentId,
                    baseSegments = segments,
                    label = tree.label,
                    mappingConfirmed = true,
                ),
            )
            viewer.announce(getString(R.string.folder_granted, tree.label))
            reloadShell()
            return
        }
        // The document is not inside the picked tree: ask the user to confirm that
        // this file really lives in that folder before using the tree root as base.
        AlertDialog.Builder(this)
            .setTitle(R.string.folder_grant_title)
            .setMessage(R.string.folder_not_containing)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                viewer.setAttachmentRoot(
                    AttachmentRoot(
                        treeUri = tree.uri,
                        rootDocumentId = tree.rootDocumentId,
                        baseSegments = emptyList(),
                        label = tree.label,
                        mappingConfirmed = false,
                    ),
                )
                reloadShell()
            }
            .setNegativeButton(android.R.string.cancel) { _, _ -> }
            .show()
    }

    private fun reloadShell() {
        shellLoadedFor = null
        val state = lastState
        if (state.phase == ViewerViewModel.Phase.READY && state.sessionId != null) {
            shellLoadedFor = state.sessionId
            webView.loadUrl(LocalAssetRouter.SHELL_URL)
        }
    }

    // ------------------------------------------------------------------ export

    private fun onExportState(state: ExportCoordinator.State, detail: String?) {
        when (state) {
            ExportCoordinator.State.PRINTING -> {
                viewer.markPrinting(true)
                viewer.announce(getString(R.string.export_printing))
            }
            ExportCoordinator.State.DONE -> {
                viewer.markPrinting(false)
                viewer.markExporting(false)
                viewer.announce(getString(R.string.export_done))
                drainPendingIntents()
            }
            ExportCoordinator.State.CANCELLED -> {
                viewer.markPrinting(false)
                viewer.markExporting(false)
                drainPendingIntents()
            }
            ExportCoordinator.State.FAILED -> {
                viewer.markPrinting(false)
                viewer.markExporting(false)
                viewer.announce(getString(R.string.export_failed, detail ?: "unknown"))
                drainPendingIntents()
            }
            else -> Unit
        }
    }

    private fun drainPendingIntents() {
        if (pendingIntents.isEmpty()) return
        val queued = ArrayList(pendingIntents)
        pendingIntents.clear()
        queued.forEach { viewer.submit(it) }
    }

    // ------------------------------------------------------- ViewerMessageBridge.Host

    override fun currentSessionId(): String? = viewer.currentSession()?.id

    override fun currentGeneration(): Long = viewer.currentGeneration()

    override fun onWebReady(): JSONObject {
        val descriptor = viewer.descriptor()
        descriptor.put("rendererAvailable", rendererAvailable)
        descriptor.put("theme", app.settings.themeMode.id)
        descriptor.put("fontScale", app.settings.fontScale.id)
        descriptor.put("wrap", app.settings.wrapText)
        descriptor.put("remoteImages", app.settings.remoteImagesEnabled)
        descriptor.put("allowLanImages", app.settings.allowLanImages)
        return descriptor
    }

    override fun onDocumentRendered(stats: JSONObject) {
        statusPanel.visibility = View.GONE
    }

    override fun onRenderError(code: String?, message: String?) {
        Redact.w("renderer reported ${code ?: "error"}")
    }

    override fun onRequestFolderGrant() = requestFolderGrant()

    override fun onCopyText(text: String) {
        copyToClipboard(text)
        viewer.announce(getString(R.string.copy_done))
    }

    override fun onOpenLocalDocument(reference: String) {
        // Resolve a document-relative reference inside the authorised tree and open
        // it as a new document in this session instead of leaving the app.
        val tree = viewer.persistedTree()
        if (tree == null) {
            viewer.announce(getString(R.string.folder_grant_failed))
            onRequestFolderGrant()
            return
        }
        val entry = viewer.registerAttachment(reference)
        if (entry == null) {
            viewer.announce(getString(R.string.error_unreadable))
            return
        }
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(entry.uri, entry.mimeType ?: "text/plain")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        viewer.submit(intent)
    }

    override fun onRegisterImages(urls: List<String>): JSONObject = viewer.registerImages(urls)

    override fun onRegisterAttachments(refs: List<String>): JSONObject = viewer.registerAttachments(refs)

    override fun onExportRequest(kind: String, options: JSONObject) {
        when (kind) {
            "pdf" -> {
                if (export.isPrinting) return
                export.print(webView, lastState.displayName ?: "LiteDoc") {
                    viewer.markPrinting(false)
                    drainPendingIntents()
                }
            }
            "svg" -> {
                viewer.markExporting(true)
                export.requestTarget(
                    this,
                    kind = "svg",
                    mime = "image/svg+xml",
                    suggestedName = viewer.suggestExportName("svg"),
                    requestCode = REQ_EXPORT,
                )
            }
            "png" -> {
                viewer.markExporting(true)
                export.requestTarget(
                    this,
                    kind = "png",
                    mime = "image/png",
                    suggestedName = viewer.suggestExportName("png"),
                    requestCode = REQ_EXPORT,
                )
            }
        }
    }

    override fun beginExport(kind: String, mime: String, name: String, totalBytes: Long): String? =
        export.beginExport(kind, mime, name, totalBytes)

    override fun writeExportChunk(exportId: String, index: Int, data: String): String? =
        export.writeChunk(exportId, index, data)

    override fun finishExport(exportId: String, sha256: String?, totalBytes: Long): Boolean =
        export.finishExport(exportId, sha256, totalBytes)

    override fun abortExport(exportId: String) = export.abortExport(exportId)

    override fun onPreference(key: String, value: String) {
        viewer.preferenceChanged(key, value)
        if (key == "theme") {
            buildToolbar()
            applyPalette()
        }
    }

    override fun onLog(level: String, message: String) {
        Redact.d("page[$level]: ${message.take(200)}")
    }

    override fun onRevealNotice(code: String, message: String?) {
        val text = when {
            code.startsWith("render-error") -> message ?: getString(R.string.error_engine_failed)
            code.startsWith("charset") -> message ?: getString(R.string.state_rendering)
            else -> message
        }
        if (text != null) viewer.announce(text)
    }

    // ------------------------------------------------------------ BridgeUiActions

    override fun onShowToc() = pushToPage("showToc", JSONObject())

    override fun onShowNotice(message: String) = viewer.announce(message)

    override fun onSwitchDocument(delta: Int) {
        if (delta >= 0) viewer.openNext() else viewer.openPrevious()
    }

    override fun onReloadCurrent() = reloadShell()

    override fun currentDescriptor(): JSONObject = viewer.descriptor()

    override fun onPreferenceChanged(key: String, value: String) = onPreference(key, value)

    // ------------------------------------------------------------------ lifecycle

    private fun pushToPage(method: String, params: JSONObject) {
        bridge.notify(
            view = webView,
            method = method,
            params = params,
            sessionId = lastState.sessionId,
            generation = lastState.generation,
        )
    }

    private fun pushPreference(key: String, value: String) {
        pushToPage("preferenceChanged", JSONObject().put("key", key).put("value", value))
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (export.isPrinting) {
            pendingIntents.add(intent)
            viewer.announce(getString(R.string.export_printing))
            return
        }
        viewer.submit(intent)
    }

    /**
     * Back handling.
     *
     * With `targetSdk 36` predictive back is enabled, so on API 33+ the platform no
     * longer calls `onBackPressed`; the callback below is what receives the gesture.
     * The legacy override is kept for older releases and simply delegates to the same
     * handler, which is why the "migrate to OnBackPressedDispatcher" lint issue does
     * not apply here.
     */
    private fun handleBack(): Boolean {
        if (searchBar.visibility == View.VISIBLE) {
            closeSearch()
            return true
        }
        if (webView.canGoBack()) {
            webView.goBack()
            return true
        }
        return false
    }

    private fun registerBackCallback() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        runCatching {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
            ) {
                if (!handleBack()) {
                    finish()
                }
            }
        }.onFailure { error ->
            Redact.w("back callback registration failed: ${error.javaClass.simpleName}")
        }
    }

    @Suppress("GestureBackNavigation")
    @Deprecated("Superseded by OnBackInvokedDispatcher from API 33; kept for older releases.")
    override fun onBackPressed() {
        if (!handleBack()) {
            super.onBackPressed()
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        applyPalette()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            REQ_FOLDER_TREE -> {
                val uri = data?.data
                if (resultCode == RESULT_OK && uri != null) {
                    onFolderTreePicked(uri)
                } else {
                    viewer.announce(getString(R.string.folder_grant_failed))
                }
            }
            REQ_EXPORT -> {
                if (!export.onActivityResult(requestCode, REQ_EXPORT, resultCode, data)) {
                    Redact.w("unexpected export result")
                }
                val pendingSource = sourceExportSessionId
                if (pendingSource != null && resultCode == RESULT_OK && data?.data != null) {
                    writeOriginalSnapshot(data.data!!)
                }
                sourceExportSessionId = null
            }
        }
    }

    private fun writeOriginalSnapshot(target: Uri) {
        val session = viewer.currentSession() ?: return
        uiScope.launch {
            val ok = kotlinx.coroutines.withContext(Dispatchers.IO) {
                try {
                    val source = session.originalFile ?: session.serveFile
                    contentResolver.openOutputStream(target, "wt")?.use { output ->
                        source.inputStream().use { input -> input.copyTo(output) }
                    }
                    true
                } catch (e: Exception) {
                    Redact.w("original export failed: ${e.javaClass.simpleName}")
                    false
                }
            }
            viewer.announce(
                if (ok) getString(R.string.export_done) else getString(R.string.export_failed, "write"),
            )
        }
    }

    override fun onDestroy() {
        stateJob?.cancel()
        uiScope.cancel()
        noticeHideJob = null
        if (export.isPrinting) {
            // A running print job keeps the WebView alive, so the activity is not
            // destroyed in that state; this is a defensive release only.
            export.release()
        }
        runCatching {
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.stopLoading()
            webView.loadUrl("about:blank")
            webView.destroy()
        }
        router.release()
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(STATE_SESSION, lastState.sessionId)
        outState.putInt(STATE_INDEX, lastState.index)
    }

    companion object {
        private const val REQ_FOLDER_TREE = 1001
        private const val REQ_EXPORT = 1002
        private const val STATE_SESSION = "session"
        private const val STATE_INDEX = "index"
    }
}
