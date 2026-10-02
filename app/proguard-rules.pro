# LiteDoc R8 rules.
#
# The app is tiny and reflection-free; these rules only keep what the Android
# platform, WebView addJavascriptInterface-free bridge and OkHttp need.

# Keep the WebView JS bridge surface (annotation-free but referenced by name
# from the message listener payloads through kotlinx.serialization-free JSON).
-keepclassmembers class dev.litedoc.viewer.** {
    public <init>(...);
}

# OkHttp / Okio
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
-dontwarn kotlinx.**

# Coroutines
-dontwarn kotlinx.coroutines.**

# Keep annotations used by lint/websocket-free builds
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
