package dev.litedoc.viewer

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import dev.litedoc.viewer.document.DocumentRepository
import dev.litedoc.viewer.document.DocumentSession
import dev.litedoc.viewer.document.DocumentSessionStore
import dev.litedoc.viewer.document.RenderMode
import dev.litedoc.viewer.image.ImageRegistry
import dev.litedoc.viewer.image.RemoteImageRepository
import dev.litedoc.viewer.intent.DocumentRef
import dev.litedoc.viewer.intent.IntentParser
import dev.litedoc.viewer.settings.ViewerSettings
import dev.litedoc.viewer.storage.AttachmentRegistry
import dev.litedoc.viewer.storage.AttachmentRoot
import dev.litedoc.viewer.storage.FolderAccessRepository
import dev.litedoc.viewer.util.Limits
import dev.litedoc.viewer.util.Redact
import dev.litedoc.viewer.web.LocalAssetRouter
import java.util.concurrent.atomic.AtomicLong
import java.io.InputStream
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject

/**
 * Orphan-free session orchestration.
 *
 * * one increasing generation per open document; results from an older generation
 *   are dropped before they can reach the UI;
 * * switching documents cancels the previous read, clears the attachment and image
 *   registries, and never keeps a View or Activity reference;
 * * the session snapshots live in a bounded LRU ([DocumentSessionStore]).
 */
class ViewerViewModel(private val app: LiteDocApp) : LocalAssetRouter.SessionHost {

    enum class Phase { IDLE, LOADING, READY, ERROR }

    data class UiState(
        val phase: Phase = Phase.IDLE,
        val labels: List<String> = emptyList(),
        val index: Int = -1,
        val sessionId: String? = null,
        val generation: Long = 0L,
        val displayName: String? = null,
        val kind: String? = null,
        val renderMode: String? = null,
        val charset: String? = null,
        val sizeBytes: Long = 0L,
        val detectionNote: String? = null,
        val warning: String? = null,
        val error: String? = null,
        val notice: String? = null,
        val droppedDocuments: Int = 0,
        val folderGranted: Boolean = false,
        val printing: Boolean = false,
        val exporting: Boolean = false,
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val generationCounter = AtomicLong(1L)
    private val store = DocumentSessionStore(java.io.File(app.cacheDir, "litedoc-sessions"))
    private val repository = DocumentRepository(app)
    private val intentParser = IntentParser()
    private val folders = FolderAccessRepository(app)
    private val attachments = AttachmentRegistry(folders)
    private val imageRegistry = ImageRegistry()
    private val images = RemoteImageRepository(app, app.settings)

    private val queue = ArrayList<DocumentRef>()
    private var index = -1
    private var active: DocumentSession? = null
    private var loadJob: Job? = null
    private var attachmentRoot: AttachmentRoot? = null

    init {
        store.purgeOrphanDirectories()
    }

    // ------------------------------------------------------------------ intents

    fun submit(intent: Intent?) {
        when (val outcome = intentParser.parse(intent)) {
            is IntentParser.Outcome.Documents -> {
                if (outcome.refs.isEmpty()) {
                    setError(app.getString(R.string.error_no_document))
                    return
                }
                val known = queue.map { it.identity }.toHashSet()
                val fresh = outcome.refs.filter { known.add(it.identity) }
                if (fresh.isEmpty()) {
                    // The same document was shared again: just focus it.
                    if (queue.isNotEmpty()) openIndex(index.coerceAtLeast(0))
                    return
                }
                val startIndex = queue.size
                queue.addAll(fresh)
                if (outcome.dropped > 0) {
                    announce(
                        app.getString(R.string.error_many_documents, Limits.MAX_DOCUMENTS_PER_INTENT),
                    )
                }
                openIndex(startIndex)
            }
            is IntentParser.Outcome.WebsiteUrl -> {
                copyToClipboard(outcome.url)
                announce(app.getString(R.string.error_url_document))
                if (queue.isEmpty()) setError(app.getString(R.string.error_url_document))
            }
            is IntentParser.Outcome.SharedText -> {
                queue.add(
                    DocumentRef(
                        uri = null,
                        sharedText = outcome.text,
                        sharedTextIsHtml = outcome.isHtml,
                    ),
                )
                openIndex(queue.size - 1)
            }
            IntentParser.Outcome.Empty -> {
                if (queue.isEmpty()) setError(app.getString(R.string.error_no_document))
            }
        }
    }

    fun documents(): List<String> = queue.map { it.label }

    fun currentIndex(): Int = index

    fun openIndex(target: Int) {
        if (target !in queue.indices) return
        loadJob?.cancel()
        val generation = generationCounter.incrementAndGet()
        index = target
        active = null
        attachments.clear()
        imageRegistry.clear()
        val ref = queue[target]
        _state.value = _state.value.copy(
            phase = Phase.LOADING,
            labels = documents(),
            index = target,
            sessionId = null,
            generation = generation,
            displayName = ref.label,
            error = null,
            warning = null,
            notice = null,
        )
        loadJob = scope.launch {
            val outcome = repository.load(ref, generation)
            if (generation != generationCounter.get()) {
                Redact.d("dropping load result from an old generation")
                return@launch
            }
            when (outcome) {
                is DocumentRepository.Outcome.Success -> adopt(outcome.session, target)
                is DocumentRepository.Outcome.Failure -> fail(outcome)
            }
        }
    }

    fun openNext() {
        if (queue.isEmpty()) return
        val next = (index + 1) % queue.size
        if (next != index) openIndex(next)
    }

    fun openPrevious() {
        if (queue.isEmpty()) return
        val previous = if (index - 1 < 0) queue.size - 1 else index - 1
        if (previous != index) openIndex(previous)
    }

    fun closeCurrent() {
        loadJob?.cancel()
        generationCounter.incrementAndGet()
        active?.let { store.remove(it.id) }
        active = null
        attachments.clear()
        imageRegistry.clear()
        queue.clear()
        index = -1
        _state.value = UiState(error = null, notice = null)
    }

    private fun adopt(session: DocumentSession, atIndex: Int) {
        store.put(session)
        active = session
        // Keep the authorised tree across documents but re-derive the base path
        // for the new document; if it cannot be located, fall back to the root of
        // the granted tree (already confirmed by the user).
        attachmentRoot = attachmentRoot?.let { root ->
            val tree = if (root.treeUri.toString() == app.settings.attachmentTreeUri) {
                folders.tree(root.treeUri)
            } else {
                null
            }
            if (tree == null) {
                null
            } else {
                val sessionUri = session.originUri?.let { runCatching { Uri.parse(it) }.getOrNull() }
                val segments = sessionUri?.let { folders.segmentsFor(tree, it) } ?: emptyList()
                root.copy(baseSegments = segments, label = tree.label)
            }
        }
        _state.value = _state.value.copy(
            phase = Phase.READY,
            labels = documents(),
            index = atIndex,
            sessionId = session.id,
            generation = session.generation,
            displayName = session.displayName,
            kind = session.kind.id,
            renderMode = session.renderMode.id,
            charset = session.detectedCharset,
            sizeBytes = session.bytesTransferred,
            detectionNote = session.detectionReason,
            warning = session.warning,
            error = null,
        )
        Redact.d("session ${session.id} ready kind=${session.kind.id} mode=${session.renderMode.id}")
    }

    private fun fail(outcome: DocumentRepository.Outcome.Failure) {
        val message = when (outcome.reason) {
            DocumentRepository.Outcome.Reason.TOO_LARGE ->
                app.getString(
                    R.string.error_too_large,
                    "${Limits.SOURCE_TEXT_MAX_BYTES / (1024 * 1024)} MiB",
                )
            DocumentRepository.Outcome.Reason.BINARY -> app.getString(R.string.error_binary)
            DocumentRepository.Outcome.Reason.UNREADABLE -> app.getString(R.string.error_unreadable)
            DocumentRepository.Outcome.Reason.UNSUPPORTED ->
                app.getString(R.string.error_not_supported, outcome.detail ?: "?")
            DocumentRepository.Outcome.Reason.EMPTY -> app.getString(R.string.error_no_document)
            DocumentRepository.Outcome.Reason.CANCELLED -> return
        }
        setError(message)
    }

    fun setError(message: String) {
        _state.value = _state.value.copy(phase = Phase.ERROR, error = message)
    }

    fun announce(message: String) {
        _state.value = _state.value.copy(notice = message)
    }

    fun clearNotice() {
        if (_state.value.notice != null) _state.value = _state.value.copy(notice = null)
    }

    fun markPrinting(printing: Boolean) {
        _state.value = _state.value.copy(printing = printing)
    }

    fun markExporting(exporting: Boolean) {
        _state.value = _state.value.copy(exporting = exporting)
    }

    // ------------------------------------------------------- LocalAssetRouter.Host

    override fun currentSession(): DocumentSession? = active

    override fun currentGeneration(): Long = generationCounter.get()

    override fun attachment(opaqueId: String): AttachmentRegistry.Entry? = attachments.get(opaqueId)

    override fun openAttachment(entry: AttachmentRegistry.Entry): InputStream? = folders.open(entry.uri)

    override fun image(opaqueId: String): ImageRegistry.Entry? = imageRegistry.get(opaqueId)

    override fun fetchImage(entry: ImageRegistry.Entry): RemoteImageRepository.Result =
        runBlocking { images.fetch(entry.url) }

    // ------------------------------------------------------------------ attachments

    fun attachmentRoot(): AttachmentRoot? = attachmentRoot

    fun setAttachmentRoot(root: AttachmentRoot) {
        attachmentRoot = root
        attachments.clear()
        folders.clearCaches()
        _state.value = _state.value.copy(folderGranted = true)
        app.settings.attachmentTreeUri = root.treeUri.toString()
    }

    fun persistedTree(): FolderAccessRepository.Tree? {
        val saved = app.settings.attachmentTreeUri ?: return null
        val uri = runCatching { Uri.parse(saved) }.getOrNull() ?: return null
        return folders.tree(uri)
    }

    fun segmentsFor(tree: FolderAccessRepository.Tree, documentUri: Uri): List<String>? =
        folders.segmentsFor(tree, documentUri)

    fun takePersistable(uri: Uri): Boolean = folders.takePersistable(uri)

    fun treeOf(uri: Uri): FolderAccessRepository.Tree? = folders.tree(uri)

    fun defaultBaseSegments(): List<String> {
        val session = active ?: return emptyList()
        val uri = session.originUri?.let { runCatching { Uri.parse(it) }.getOrNull() } ?: return emptyList()
        val tree = persistedTree() ?: return emptyList()
        return folders.segmentsFor(tree, uri) ?: emptyList()
    }

    fun revokeAttachmentRoot() {
        persistedTree()?.let { folders.release(it.uri) }
        app.settings.attachmentTreeUri = null
        attachmentRoot = null
        attachments.clear()
        folders.clearCaches()
        _state.value = _state.value.copy(folderGranted = false)
    }

    /**
     * Resolves document-relative attachment references to local session URLs.
     * References that cannot be resolved are reported as missing instead of being
     * silently dropped, and nothing outside the authorised tree is reachable.
     */
    fun registerAttachments(refs: List<String>): JSONObject {
        val registered = JSONArray()
        val missing = JSONArray()
        val sessionId = active?.id
        if (sessionId == null || attachmentRoot == null) {
            for (ref in refs.take(512)) missing.put(ref)
            return JSONObject()
                .put("registered", registered)
                .put("missing", missing)
                .put("reason", if (attachmentRoot == null) "no-folder-grant" else "no-session")
        }
        for (ref in refs.take(512)) {
            val entry = attachments.register(attachmentRoot!!, ref)
            if (entry == null) {
                missing.put(ref)
            } else {
                registered.put(
                    JSONObject()
                        .put("ref", ref)
                        .put("id", entry.opaqueId)
                        .put("localUrl", LocalAssetRouter.resourceUrl(sessionId, entry.opaqueId)),
                )
            }
        }
        return JSONObject().put("registered", registered).put("missing", missing)
    }

    fun registerAttachment(reference: String): AttachmentRegistry.Entry? {
        val root = attachmentRoot ?: return null
        return attachments.register(root, reference)
    }

    // ------------------------------------------------------------------ images

    fun registerImages(urls: List<String>): JSONObject {
        val registered = JSONArray()
        val rejected = JSONArray()
        for (url in urls.take(512)) {
            if (!RemoteImageRepository.isRemoteReference(url)) {
                rejected.put(JSONObject().put("url", url).put("reason", "not-remote"))
                continue
            }
            if (!app.settings.remoteImagesEnabled) {
                rejected.put(JSONObject().put("url", url).put("reason", "disabled"))
                continue
            }
            val entry = imageRegistry.register(url)
            registered.put(
                JSONObject()
                    .put("url", url)
                    .put("id", entry.opaqueId)
                    .put("localUrl", LocalAssetRouter.imageUrl(active?.id ?: "", entry.opaqueId)),
            )
        }
        return JSONObject().put("registered", registered).put("rejected", rejected)
    }

    fun clearImageCache(): Long {
        val before = images.cacheSizeBytes()
        images.clearCache()
        return before
    }

    fun imageCacheSize(): Long = images.cacheSizeBytes()

    // ------------------------------------------------------------------ settings

    fun descriptor(): JSONObject {
        val session = active
        val capabilities = JSONObject()
            .put("rich", session?.renderMode == RenderMode.RICH)
            .put("renderMode", session?.renderMode?.id ?: RenderMode.SOURCE.id)
            .put("math", session?.renderMode == RenderMode.RICH)
            .put("mermaid", session?.renderMode == RenderMode.RICH)
            .put("smiles", session?.renderMode == RenderMode.RICH)
            .put("csv", session?.renderMode == RenderMode.RICH)
            .put("remoteImages", app.settings.remoteImagesEnabled)
            .put("allowLanImages", app.settings.allowLanImages)
            .put("folderGranted", attachmentRoot != null)
            .put("theme", app.settings.themeMode.id)
            .put("fontScale", app.settings.fontScale.id)
            .put("wrap", app.settings.wrapText)
            .put("version", BuildConfig.VERSION_NAME)
            .put("protocol", 1)

        val json = JSONObject()
            .put("sessionId", session?.id ?: JSONObject.NULL)
            .put("generation", session?.generation ?: 0L)
            .put("kind", session?.kind?.id ?: "unknown")
            .put("renderMode", session?.renderMode?.id ?: "source")
            .put("displayName", session?.displayName ?: "")
            .put("mimeType", session?.mimeType ?: "text/plain")
            .put("charset", session?.detectedCharset ?: "UTF-8")
            .put("sizeBytes", session?.bytesTransferred ?: 0L)
            .put("confidence", session?.confidence?.name?.lowercase() ?: "low")
            .put("detection", session?.detectionReason ?: "")
            .put("warning", session?.warning ?: JSONObject.NULL)
            .put("sourceUrl", session?.let { LocalAssetRouter.sourceUrl(it.id) } ?: JSONObject.NULL)
            .put("capabilities", capabilities)
        attachmentRoot?.let { root ->
            json.put(
                "attachmentRoot",
                JSONObject()
                    .put("label", root.label)
                    .put("base", root.baseSegments.joinToString("/"))
                    .put("confirmed", root.mappingConfirmed),
            )
        }
        return json
    }

    fun preferenceChanged(key: String, value: String) {
        when (key) {
            "theme" -> app.settings.themeMode = ViewerSettings.ThemeMode.fromId(value)
            "fontScale" -> app.settings.fontScale = ViewerSettings.FontScale.fromId(value)
            "wrap" -> app.settings.wrapText = value == "true"
            "remoteImages" -> app.settings.remoteImagesEnabled = value == "true"
            "allowLan" -> app.settings.allowLanImages = value == "true"
            else -> Redact.w("unknown preference key ignored")
        }
    }

    fun rereadWith(charset: String) {
        val session = active ?: return
        val generation = generationCounter.incrementAndGet()
        loadJob?.cancel()
        _state.value = _state.value.copy(phase = Phase.LOADING, error = null)
        loadJob = scope.launch {
            when (val outcome = repository.redecode(session, charset, generation)) {
                is DocumentRepository.Outcome.Success -> adopt(outcome.session, index)
                is DocumentRepository.Outcome.Failure -> fail(outcome)
            }
        }
    }

    fun shutdown() {
        loadJob?.cancel()
        generationCounter.incrementAndGet()
        attachments.clear()
        imageRegistry.clear()
        active?.let { store.remove(it.id) }
        active = null
    }

    private fun copyToClipboard(text: String) {
        val clipboard = app.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
        runCatching { clipboard.setPrimaryClip(ClipData.newPlainText("LiteDoc", text)) }
    }

    fun documentKindId(): String = active?.kind?.id ?: "unknown"

    fun suggestExportName(extension: String): String {
        val base = active?.displayName?.substringBeforeLast('.') ?: "litedoc"
        val safe = base.replace(Regex("[^\\p{L}\\p{N}._-]"), "_").take(64).ifEmpty { "litedoc" }
        return "$safe.$extension"
    }

}
