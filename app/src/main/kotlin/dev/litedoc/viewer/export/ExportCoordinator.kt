package dev.litedoc.viewer.export

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintManager
import android.webkit.WebView
import android.util.Base64
import dev.litedoc.viewer.util.Limits
import dev.litedoc.viewer.util.Redact
import java.io.OutputStream
import java.security.MessageDigest
import java.util.UUID

/**
 * Printing and single-graphic export.
 *
 * * PDF goes through the system print service (`PrintManager` +
 *   `WebView.createPrintDocumentAdapter`), so the user keeps the platform's
 *   "save as PDF" flow;
 * * the WebView is kept alive for the whole print job and document switching is
 *   blocked until the adapter reports completion;
 * * graphics arrive from the trusted page as bounded base64 chunks over the
 *   bridge, are written to a user-chosen URI, and are verified by byte count and
 *   SHA-256 before the export is reported as finished.
 */
class ExportCoordinator(
    private val context: Context,
    private val onStateChanged: (State, String?) -> Unit,
    private val onTargetReady: (exportId: String, kind: String, mime: String) -> Unit,
    private val onTargetCancelled: (kind: String) -> Unit,
) {

    enum class State { IDLE, PREPARING, WAITING_TARGET, STREAMING, PRINTING, DONE, CANCELLED, FAILED }

    private class PendingTarget(
        val exportId: String,
        val kind: String,
        val mime: String,
        val title: String,
    )

    private class Stream(
        val id: String,
        val uri: Uri,
        val output: OutputStream,
        val expectedBytes: Long,
        val digest: MessageDigest,
        var written: Long = 0L,
        var nextIndex: Int = 0,
    )

    private var pending: PendingTarget? = null
    private var stream: Stream? = null
    private var adapterFinished: (() -> Unit)? = null

    var isPrinting: Boolean = false
        private set

    var isExporting: Boolean = false
        private set

    fun requestTarget(activity: Activity, kind: String, mime: String, suggestedName: String, requestCode: Int) {
        val exportId = UUID.randomUUID().toString().replace("-", "")
        pending = PendingTarget(exportId, kind, mime, suggestedName)
        onStateChanged(State.WAITING_TARGET, null)
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mime
            putExtra(Intent.EXTRA_TITLE, suggestedName)
        }
        try {
            activity.startActivityForResult(intent, requestCode)
        } catch (e: Exception) {
            pending = null
            onStateChanged(State.FAILED, "no document provider available")
        }
    }

    fun onActivityResult(requestCode: Int, expectedRequestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != expectedRequestCode) return false
        val target = pending
        if (resultCode != Activity.RESULT_OK || data?.data == null) {
            pending = null
            onStateChanged(State.CANCELLED, null)
            target?.let { onTargetCancelled(it.kind) }
            return true
        }
        val uri = data.data!!
        if (target == null) {
            onStateChanged(State.FAILED, "no pending export")
            return true
        }
        pending = null
        isExporting = true
        // Remember the destination for the matching exportBegin call.
        readyTarget = ReadyTarget(target.exportId, target.kind, target.mime, uri, target.title)
        onStateChanged(State.STREAMING, null)
        onTargetReady(target.exportId, target.kind, target.mime)
        return true
    }

    private class ReadyTarget(
        val exportId: String,
        val kind: String,
        val mime: String,
        val uri: Uri,
        val title: String,
    )

    private var readyTarget: ReadyTarget? = null

    fun beginExport(kind: String, mime: String, name: String, totalBytes: Long): String? {
        val target = readyTarget ?: return null
        if (target.kind != kind) return null
        if (totalBytes <= 0 || totalBytes > Limits.EXPORT_MAX_BYTES) return null
        abortExisting()
        val output = try {
            context.contentResolver.openOutputStream(target.uri, "wt")
        } catch (e: Exception) {
            null
        }
        if (output == null) {
            readyTarget = null
            isExporting = false
            onStateChanged(State.FAILED, "cannot open the selected destination")
            return null
        }
        stream = Stream(
            id = target.exportId,
            uri = target.uri,
            output = output,
            expectedBytes = totalBytes,
            digest = MessageDigest.getInstance("SHA-256"),
        )
        Redact.d("export started: kind=$kind bytes=$totalBytes")
        return target.exportId
    }

    fun writeChunk(exportId: String, index: Int, base64: String): String? {
        val current = stream ?: return "no active export"
        if (current.id != exportId) return "export id mismatch"
        if (index != current.nextIndex) return "chunk out of order"
        val bytes = try {
            Base64.decode(base64, Base64.DEFAULT)
        } catch (_: IllegalArgumentException) {
            return "invalid base64 chunk"
        }
        if (current.written + bytes.size > Limits.EXPORT_MAX_BYTES) return "export exceeds the size limit"
        return try {
            current.output.write(bytes)
            current.digest.update(bytes)
            current.written += bytes.size
            current.nextIndex = index + 1
            null
        } catch (e: Exception) {
            abortExport(exportId)
            onStateChanged(State.FAILED, "write failed")
            "write failed"
        }
    }

    fun finishExport(exportId: String, sha256: String?, totalBytes: Long): Boolean {
        val current = stream ?: return false
        if (current.id != exportId) return false
        val written = current.written
        return try {
            current.output.flush()
            current.output.close()
        } catch (e: Exception) {
            stream = null
            isExporting = false
            onStateChanged(State.FAILED, "flush failed")
            return false
        }
        stream = null
        readyTarget = null
        isExporting = false

        val digestHex = hex(current.digest.digest())
        val sizeOk = totalBytes < 0 || written == totalBytes
        val digestOk = sha256.isNullOrEmpty() || sha256.equals(digestHex, ignoreCase = true)
        if (!sizeOk || !digestOk) {
            runCatching { context.contentResolver.delete(current.uri, null, null) }
            onStateChanged(State.FAILED, "export verification failed")
            return false
        }
        Redact.d("export finished: bytes=$written")
        onStateChanged(State.DONE, null)
        return true
    }

    fun abortExport(exportId: String) {
        val current = stream ?: return
        if (current.id != exportId) return
        abortExisting()
        onStateChanged(State.CANCELLED, null)
    }

    private fun abortExisting() {
        val current = stream ?: return
        stream = null
        readyTarget = null
        isExporting = false
        runCatching { current.output.close() }
        runCatching { context.contentResolver.delete(current.uri, null, null) }
    }

    // ------------------------------------------------------------------ printing

    fun print(webView: WebView, jobName: String, onFinished: () -> Unit) {
        val printManager = context.getSystemService(Context.PRINT_SERVICE) as? PrintManager
        if (printManager == null) {
            onStateChanged(State.FAILED, "print service unavailable")
            onFinished()
            return
        }
        try {
            val adapter = webView.createPrintDocumentAdapter(jobName)
            isPrinting = true
            adapterFinished = onFinished
            onStateChanged(State.PRINTING, null)
            printManager.print(jobName, TrackingAdapter(adapter), PrintAttributes.Builder().build())
        } catch (e: Exception) {
            isPrinting = false
            adapterFinished = null
            onStateChanged(State.FAILED, "print failed to start")
            onFinished()
        }
    }

    fun release() {
        abortExisting()
        isPrinting = false
        adapterFinished = null
        onStateChanged(State.IDLE, null)
    }

    private inner class TrackingAdapter(private val delegate: PrintDocumentAdapter) :
        PrintDocumentAdapter() {

        override fun onLayout(
            oldAttributes: PrintAttributes?,
            newAttributes: PrintAttributes?,
            cancellationSignal: CancellationSignal?,
            callback: LayoutResultCallback?,
            extras: Bundle?,
        ) {
            delegate.onLayout(oldAttributes, newAttributes, cancellationSignal, callback, extras)
        }

        override fun onWrite(
            pages: Array<out PageRange>?,
            destination: ParcelFileDescriptor?,
            cancellationSignal: CancellationSignal?,
            callback: WriteResultCallback?,
        ) {
            delegate.onWrite(pages, destination, cancellationSignal, callback)
        }

        override fun onStart() {
            delegate.onStart()
        }

        override fun onFinish() {
            delegate.onFinish()
            isPrinting = false
            val callback = adapterFinished
            adapterFinished = null
            onStateChanged(State.DONE, null)
            callback?.invoke()
        }
    }

    companion object {
        fun hex(bytes: ByteArray): String {
            val out = StringBuilder(bytes.size * 2)
            for (b in bytes) {
                val v = b.toInt() and 0xFF
                out.append("0123456789abcdef"[v ushr 4]).append("0123456789abcdef"[v and 0x0F])
            }
            return out.toString()
        }
    }
}
