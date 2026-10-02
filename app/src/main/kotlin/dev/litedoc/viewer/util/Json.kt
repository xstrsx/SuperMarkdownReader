package dev.litedoc.viewer.util

import org.json.JSONArray
import org.json.JSONObject

/**
 * Minimal JSON helpers used by the message bridge. The bridge payloads are small
 * control messages, so a full serialization framework is not worth the bytes.
 */
object Json {

    fun parseObject(raw: String): JSONObject? = try {
        JSONObject(raw)
    } catch (_: Exception) {
        null
    }

    fun optString(obj: JSONObject, key: String, maxChars: Int = 4096): String? {
        val value = obj.optString(key, "")
        if (value.isEmpty()) return null
        return if (value.length > maxChars) value.substring(0, maxChars) else value
    }

    fun stringArray(obj: JSONObject, key: String, maxItems: Int): List<String> {
        val array = obj.optJSONArray(key) ?: return emptyList()
        val out = ArrayList<String>(minOf(array.length(), maxItems))
        for (i in 0 until minOf(array.length(), maxItems)) {
            val value = array.optString(i)
            if (value.isNotEmpty()) out.add(value)
        }
        return out
    }

    fun toArray(values: List<String>): JSONArray {
        val array = JSONArray()
        values.forEach { array.put(it) }
        return array
    }
}
