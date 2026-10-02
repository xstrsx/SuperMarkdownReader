package dev.litedoc.viewer.storage

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import dev.litedoc.viewer.util.Redact
import java.io.InputStream

/**
 * Access to user-authorised folder trees (ACTION_OPEN_DOCUMENT_TREE).
 *
 * * persistable permission is only taken when the system actually granted the
 *   persistable flag;
 * * the provider's document-ID scheme is never concatenated by hand: children are
 *   looked up by walking from the authorised root with DocumentsContract queries;
 * * every lookup starts at the root, so `..` cannot leave the authorised tree;
 * * a tree that no longer resolves (deleted folder, revoked grant) is reported and
 *   can be revoked from the menu.
 */
class FolderAccessRepository(private val context: Context) {

    private val resolver: ContentResolver get() = context.contentResolver

    /** Cached "parentDocId\u0000name" -> documentId lookups. */
    private val childCache = HashMap<String, String?>()

    data class Tree(val uri: Uri, val rootDocumentId: String, val label: String)

    fun persistedTrees(): List<Tree> = resolver.persistedUriPermissions
        .filter { it.isReadPermission }
        .mapNotNull { permission ->
            runCatching { tree(permission.uri) }.getOrNull()
        }

    fun tree(uri: Uri): Tree? {
        return try {
            val rootId = DocumentsContract.getTreeDocumentId(uri)
            Tree(uri, rootId, displayName(uri) ?: uri.lastPathSegment ?: "tree")
        } catch (e: Exception) {
            Redact.w("tree open failed: ${e.javaClass.simpleName}")
            null
        }
    }

    /**
     * Returns true only when the persistable flag was really granted by the
     * provider. A plain share grant is never assumed to be permanent.
     */
    fun takePersistable(uri: Uri): Boolean {
        val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        return try {
            resolver.takePersistableUriPermission(uri, flags)
            true
        } catch (e: SecurityException) {
            Redact.w("persistable grant refused by provider")
            false
        } catch (e: Exception) {
            false
        }
    }

    fun release(uri: Uri) {
        runCatching {
            resolver.releasePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
        }
        childCache.clear()
    }

    fun releaseAll() {
        persistedTrees().forEach { release(it.uri) }
    }

    fun displayName(uri: Uri): String? {
        var cursor: android.database.Cursor? = null
        return try {
            cursor = resolver.query(
                uri,
                arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME),
                null,
                null,
                null,
            )
            if (cursor != null && cursor.moveToFirst()) cursor.getString(0) else null
        } catch (_: Exception) {
            null
        } finally {
            runCatching { cursor?.close() }
        }
    }

    /** Direct children of [parentDocumentId], as (name, documentId) pairs. */
    fun children(tree: Tree, parentDocumentId: String, limit: Int = 5_000): List<Pair<String, String>> {
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(tree.uri, parentDocumentId)
        val projection = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
        )
        val out = ArrayList<Pair<String, String>>()
        var cursor: android.database.Cursor? = null
        try {
            cursor = resolver.query(childrenUri, projection, null, null, null)
            if (cursor != null) {
                while (cursor.moveToNext() && out.size < limit) {
                    val id = cursor.getString(0) ?: continue
                    val name = cursor.getString(1) ?: continue
                    out.add(name to id)
                }
            }
        } catch (e: Exception) {
            Redact.w("child listing failed: ${e.javaClass.simpleName}")
        } finally {
            runCatching { cursor?.close() }
        }
        return out
    }

    fun childDocumentId(tree: Tree, parentDocumentId: String, name: String): String? {
        val key = "$parentDocumentId\u0000$name"
        if (childCache.containsKey(key)) return childCache[key]

        val children = children(tree, parentDocumentId)
        val exact = children.firstOrNull { it.first == name }
        val resolved = exact?.second
            ?: children.filter { it.first.equals(name, ignoreCase = true) }
                .takeIf { it.size == 1 }
                ?.first()
                ?.second
        childCache[key] = resolved
        return resolved
    }

    fun isDirectory(tree: Tree, documentId: String): Boolean {
        val uri = DocumentsContract.buildDocumentUriUsingTree(tree.uri, documentId)
        var cursor: android.database.Cursor? = null
        return try {
            cursor = resolver.query(
                uri,
                arrayOf(DocumentsContract.Document.COLUMN_MIME_TYPE),
                null,
                null,
                null,
            )
            val mime = if (cursor != null && cursor.moveToFirst()) cursor.getString(0) else null
            mime == DocumentsContract.Document.MIME_TYPE_DIR
        } catch (_: Exception) {
            false
        } finally {
            runCatching { cursor?.close() }
        }
    }

    fun documentUri(tree: Tree, documentId: String): Uri =
        DocumentsContract.buildDocumentUriUsingTree(tree.uri, documentId)

    /**
     * Walks [segments] from the authorised root. Returns null when any segment is
     * missing, which is also what protects against traversal: the result is always
     * a descendant of the root, whatever the segments contained.
     */
    fun resolveSegments(tree: Tree, segments: List<String>): String? {
        var current = tree.rootDocumentId
        for (segment in segments) {
            current = childDocumentId(tree, current, segment) ?: return null
        }
        return current
    }

    fun open(uri: Uri): InputStream? = try {
        resolver.openInputStream(uri)
    } catch (e: Exception) {
        Redact.w("attachment open failed: ${e.javaClass.simpleName}")
        null
    }

    /**
     * Best-effort mapping of an opened document URI to its path inside [tree].
     * Document IDs are hierarchical for the standard providers, so the search
     * descends only into the ancestor chain. Returns null when the document is not
     * inside the tree, which the UI then turns into an explicit
     * "this file is in that folder" confirmation.
     */
    fun segmentsFor(tree: Tree, documentUri: Uri): List<String>? {
        val targetId = try {
            DocumentsContract.getDocumentId(documentUri)
        } catch (_: Exception) {
            return null
        }
        if (targetId == tree.rootDocumentId) return emptyList()

        val path = ArrayList<String>()
        if (descend(tree, tree.rootDocumentId, targetId, path, depth = 0)) return path
        return null
    }

    private fun descend(
        tree: Tree,
        parentId: String,
        targetId: String,
        path: MutableList<String>,
        depth: Int,
    ): Boolean {
        if (depth > 24) return false
        for ((name, id) in children(tree, parentId)) {
            if (id == targetId) {
                path.add(name)
                return true
            }
            if (targetId.startsWith("$id/")) {
                path.add(name)
                if (descend(tree, id, targetId, path, depth + 1)) return true
                path.removeAt(path.size - 1)
            }
        }
        return false
    }

    fun clearCaches() = childCache.clear()
}
