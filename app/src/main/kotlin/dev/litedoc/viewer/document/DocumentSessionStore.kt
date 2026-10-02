package dev.litedoc.viewer.document

import dev.litedoc.viewer.util.Limits
import dev.litedoc.viewer.util.Redact
import java.io.File

/**
 * Small LRU of open documents (default 20). Snapshots are temporary: they are
 * deleted on eviction and when the app shuts the store down, and the total
 * snapshot budget is bounded. Documents are never copied into a permanent
 * library.
 */
class DocumentSessionStore(private val rootDir: File) {

    private val entries = LinkedHashMap<String, DocumentSession>()

    @Synchronized
    fun put(session: DocumentSession) {
        entries.remove(session.id)
        entries[session.id] = session
        evictIfNeeded(keepId = session.id)
    }

    @Synchronized
    fun get(id: String?): DocumentSession? = id?.let { entries[it] }

    @Synchronized
    fun remove(id: String): DocumentSession? {
        val removed = entries.remove(id) ?: return null
        deleteSnapshot(removed)
        return removed
    }

    @Synchronized
    fun ids(): List<String> = entries.keys.toList()

    @Synchronized
    fun totalSnapshotBytes(): Long = entries.values.sumOf { it.snapshotBytes }

    @Synchronized
    fun closeAll() {
        entries.values.forEach { deleteSnapshot(it) }
        entries.clear()
    }

    @Synchronized
    fun removeAllExcept(ids: Set<String>) {
        val iterator = entries.entries.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            if (entry.key !in ids) {
                deleteSnapshot(entry.value)
                iterator.remove()
            }
        }
    }

    private fun evictIfNeeded(keepId: String) {
        while (entries.size > Limits.MAX_SESSIONS) {
            val victim = entries.keys.firstOrNull { it != keepId } ?: return
            entries.remove(victim)?.let { deleteSnapshot(it) }
        }
        while (totalSnapshotBytes() > Limits.SNAPSHOT_TOTAL_BUDGET_BYTES && entries.size > 1) {
            val victim = entries.keys.firstOrNull { it != keepId } ?: return
            entries.remove(victim)?.let { deleteSnapshot(it) }
        }
    }

    private fun deleteSnapshot(session: DocumentSession) {
        runCatching { session.serveFile.delete() }
        session.originalFile?.let { runCatching { it.delete() } }
        val dir = File(rootDir, session.id)
        if (dir.isDirectory) {
            dir.listFiles()?.forEach { runCatching { it.delete() } }
            runCatching { dir.delete() }
        }
        Redact.d("session ${session.id} snapshot released")
    }

    /** Called on process start to drop snapshots orphaned by a previous run. */
    fun purgeOrphanDirectories() {
        val dirs = rootDir.listFiles() ?: return
        for (dir in dirs) {
            if (!dir.isDirectory) continue
            if (entries.containsKey(dir.name)) continue
            dir.listFiles()?.forEach { runCatching { it.delete() } }
            runCatching { dir.delete() }
        }
    }
}
