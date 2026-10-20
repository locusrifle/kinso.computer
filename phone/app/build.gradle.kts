import java.util.Properties

plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

// The release key is a credential, so it is not here: a properties
// file named by IMPERFECT_ANDROID_SIGNING (storeFile, storePassword, keyAlias,
// keyPassword). Every update must be signed with the same key or Android
// refuses to install it over the last one.
val releaseSigning: Properties? = System.getenv("IMPERFECT_ANDROID_SIGNING")
  ?.let { file(it) }
  ?.takeIf { it.isFile }
  ?.let { f -> Properties().apply { f.inputStream().use { load(it) } } }

android {
  namespace = "computer.imperfect.code"
  compileSdk = 36

  defaultConfig {
    applicationId = "computer.imperfect.code"
    minSdk = 28
    targetSdk = 36
    versionCode = 1
    versionName = "0.1"
  }

  signingConfigs {
    if (releaseSigning != null) create("release") {
      storeFile = file(releaseSigning.getProperty("storeFile"))
      storePassword = releaseSigning.getProperty("storePassword")
      keyAlias = releaseSigning.getProperty("keyAlias")
      keyPassword = releaseSigning.getProperty("keyPassword")
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      if (releaseSigning != null) signingConfig = signingConfigs.getByName("release")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions {
    jvmTarget = "17"
  }
}

dependencies {
  implementation("androidx.appcompat:appcompat:1.7.0")
  implementation("androidx.core:core-ktx:1.15.0")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
  implementation("androidx.webkit:webkit:1.12.1")
  // "Scan QR code" on the first screen: Google Play services draws the
  // camera and hands back the code, so no scanner or camera permission ships.
  implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
