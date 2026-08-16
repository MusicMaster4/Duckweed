plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.gms.google-services")
}

android {
    namespace = "dev.slop.duckweed.companion"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.slop.duckweed.companion"
        minSdk = 23
        targetSdk = 36
        versionCode = (providers.gradleProperty("duckweedVersionCode").orNull ?: "1").toInt()
        versionName = providers.gradleProperty("duckweedVersionName").orNull ?: "0.1.0"
    }

    val releaseKeystore = System.getenv("DUCKWEED_ANDROID_KEYSTORE")
    val releaseStorePassword = System.getenv("DUCKWEED_ANDROID_STORE_PASSWORD")
    val releaseKeyAlias = System.getenv("DUCKWEED_ANDROID_KEY_ALIAS")
    val releaseKeyPassword = System.getenv("DUCKWEED_ANDROID_KEY_PASSWORD")
    val releaseSigning = if (
        releaseKeystore != null && releaseStorePassword != null &&
        releaseKeyAlias != null && releaseKeyPassword != null
    ) {
        signingConfigs.create("duckweedRelease") {
            storeFile = file(releaseKeystore)
            storePassword = releaseStorePassword
            keyAlias = releaseKeyAlias
            keyPassword = releaseKeyPassword
        }
    } else null

    buildTypes {
        release {
            signingConfig = releaseSigning
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation(platform("com.google.firebase:firebase-bom:34.17.0"))
    implementation("com.google.firebase:firebase-messaging")
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.recyclerview:recyclerview:1.4.0")
    implementation("androidx.work:work-runtime-ktx:2.10.5")
    testImplementation("junit:junit:4.13.2")
}
