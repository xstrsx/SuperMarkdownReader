package dev.litedoc.viewer.settings

import android.content.Context

/**
 * The small set of persisted preferences (plan: theme, font size, wrapping,
 * remote images). Nothing else is stored, and no document content is ever kept
 * here.
 */
class ViewerSettings(context: Context) {

    enum class ThemeMode(val id: String) {
        SYSTEM("system"),
        LIGHT("light"),
        DARK("dark"),
        ;

        companion object {
            fun fromId(id: String?): ThemeMode = entries.firstOrNull { it.id == id } ?: SYSTEM
        }
    }

    enum class FontScale(val id: String, val scale: Float) {
        SMALL("small", 0.9f),
        NORMAL("normal", 1.0f),
        LARGE("large", 1.18f),
        HUGE("huge", 1.4f),
        ;

        companion object {
            fun fromId(id: String?): FontScale = entries.firstOrNull { it.id == id } ?: NORMAL
        }
    }

    private val prefs = context.getSharedPreferences("litedoc-settings", Context.MODE_PRIVATE)

    var themeMode: ThemeMode
        get() = ThemeMode.fromId(prefs.getString(KEY_THEME, null))
        set(value) = prefs.edit().putString(KEY_THEME, value.id).apply()

    var fontScale: FontScale
        get() = FontScale.fromId(prefs.getString(KEY_FONT, null))
        set(value) = prefs.edit().putString(KEY_FONT, value.id).apply()

    var wrapText: Boolean
        get() = prefs.getBoolean(KEY_WRAP, true)
        set(value) = prefs.edit().putBoolean(KEY_WRAP, value).apply()

    var remoteImagesEnabled: Boolean
        get() = prefs.getBoolean(KEY_IMAGES, true)
        set(value) = prefs.edit().putBoolean(KEY_IMAGES, value).apply()

    var allowLanImages: Boolean
        get() = prefs.getBoolean(KEY_LAN, false)
        set(value) = prefs.edit().putBoolean(KEY_LAN, value).apply()

    /** Last explicitly granted attachment tree, if any. */
    var attachmentTreeUri: String?
        get() = prefs.getString(KEY_TREE, null)
        set(value) = prefs.edit().putString(KEY_TREE, value).apply()

    fun isDark(): Boolean = themeMode == ThemeMode.DARK

    private companion object {
        const val KEY_THEME = "theme"
        const val KEY_FONT = "fontScale"
        const val KEY_WRAP = "wrapText"
        const val KEY_IMAGES = "remoteImages"
        const val KEY_LAN = "allowLan"
        const val KEY_TREE = "attachmentTree"
    }
}
