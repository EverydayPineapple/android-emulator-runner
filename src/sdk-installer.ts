import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import * as fs from 'fs';

const BUILD_TOOLS_VERSION = '30.0.0';
const CMDLINE_TOOLS_URL_MAC = 'https://dl.google.com/android/repository/commandlinetools-mac-6609375_latest.zip';
const CMDLINE_TOOLS_URL_LINUX = 'https://dl.google.com/android/repository/commandlinetools-linux-6609375_latest.zip';
const BASE_ANDROID_SDK_URL_MAC = 'https://dl.google.com/android/repository/sdk-tools-darwin-4333796.zip';
const BASE_ANDROID_SDK_URL_LINUX = 'https://dl.google.com/android/repository/sdk-tools-linux-4333796.zip';

/**
 * Installs & updates the Android SDK for the macOS platform, including SDK platform for the chosen API level, latest build tools, platform tools, Android Emulator,
 * and the system image for the chosen API level, CPU arch, and target.
 */
export async function installAndroidSdk(apiLevel: number, target: string, arch: string, emulatorBuild?: string, ndkVersion?: string, cmakeVersion?: string): Promise<void> {
  const isOnMac = process.platform === 'darwin';

  // Check if ANDROID_HOME is set.
  if (!process.env.ANDROID_HOME) {
    core.setFailed('ANDROID_HOME is a required environment variable and is not set.\nPlease double check your host settings.');
    return;
  }

  if (fs.existsSync(process.env.ANDROID_HOME)) {
    console.log('Using previous installation of base Android SDK, found on ${process.env.ANDROID_HOME}');
  } else {
    const installed = await installBaseSdk();
    if (!installed) {
      core.setFailed('Could not install base Android SDK.');
      return;
    }
    const licenses = await acceptLicenses();
    if (!installed || !licenses) {
      core.setFailed('Could not accept Android SDK licenses.');
      return;
    }
  }

  // fresh installation
  const freshInstall = core.getInput('fresh-sdk-installation');
  // It is not required to configure permissions on self-hosted and macos
  // environment.
  if (!isOnMac && !freshInstall) {
    await exec.exec(`sh -c \\"sudo chown $USER:$USER ${process.env.ANDROID_HOME} -R`);
  }

  const cmdlineToolsPath = `${process.env.ANDROID_HOME}/cmdline-tools`;
  if (!fs.existsSync(cmdlineToolsPath)) {
    console.log('Installing new cmdline-tools.');
    const sdkUrl = isOnMac ? CMDLINE_TOOLS_URL_MAC : CMDLINE_TOOLS_URL_LINUX;
    await io.mkdirP(`${process.env.ANDROID_HOME}/cmdline-tools`);
    await exec.exec(`curl -fo commandlinetools.zip ${sdkUrl}`);
    await exec.exec(`unzip -q commandlinetools.zip -d ${cmdlineToolsPath}`);
    await io.rmRF('commandlinetools.zip');

    // add paths for commandline-tools and platform-tools
    core.addPath(`${cmdlineToolsPath}/tools:${cmdlineToolsPath}/tools/bin:${process.env.ANDROID_HOME}/platform-tools`);
  }

  // additional permission and license requirements for Linux
  const sdkPreviewLicensePath = `${process.env.ANDROID_HOME}/licenses/android-sdk-preview-license`;
  if (!isOnMac && !fs.existsSync(sdkPreviewLicensePath)) {
    fs.writeFileSync(sdkPreviewLicensePath, '\n84831b9409646a918e30573bab4c9c91346d8abd');
  }

  // license required for API 30 system images
  const sdkArmDbtLicensePath = `${process.env.ANDROID_HOME}/licenses/android-sdk-arm-dbt-license`;
  if (apiLevel == 30 && !fs.existsSync(sdkArmDbtLicensePath)) {
    fs.writeFileSync(sdkArmDbtLicensePath, '\n859f317696f67ef3d7f30a50a5560e7834b43903');
  }

  console.log('Installing latest build tools, platform tools, and platform.');

  await exec.exec(`sh -c \\"sdkmanager --install 'build-tools;${BUILD_TOOLS_VERSION}' platform-tools 'platforms;android-${apiLevel}' > /dev/null"`);
  if (emulatorBuild) {
    console.log(`Installing emulator build ${emulatorBuild}.`);
    await exec.exec(`curl -fo emulator.zip https://dl.google.com/android/repository/emulator-${isOnMac ? 'darwin' : 'linux'}-${emulatorBuild}.zip`);
    await io.rmRF(`${process.env.ANDROID_HOME}/emulator`);
    await exec.exec(`unzip -q emulator.zip -d ${process.env.ANDROID_HOME}`);
    await io.rmRF('emulator.zip');
  } else {
    console.log('Installing latest emulator.');
    await exec.exec(`sh -c \\"sdkmanager --install emulator > /dev/null"`);
  }
  console.log('Installing system images.');
  await exec.exec(`sh -c \\"sdkmanager --install 'system-images;android-${apiLevel};${target};${arch}' > /dev/null"`);

  if (ndkVersion) {
    console.log(`Installing NDK ${ndkVersion}.`);
    await exec.exec(`sh -c \\"sdkmanager --install 'ndk;${ndkVersion}' > /dev/null"`);
  }
  if (cmakeVersion) {
    console.log(`Installing CMake ${cmakeVersion}.`);
    await exec.exec(`sh -c \\"sdkmanager --install 'cmake;${cmakeVersion}' > /dev/null"`);
  }
}

async function installBaseSdk() {
  const isOnMac = process.platform === 'darwin';
  const baseSdkUrl = isOnMac ? BASE_ANDROID_SDK_URL_MAC : BASE_ANDROID_SDK_URL_LINUX;
  const androidTmpPath = '/tmp/android-sdk.zip';
  const androidHome = process.env.ANDROID_HOME;
  console.log(`Installing Android SDK on ${androidHome}`);

  // Backup existing .android folder.
  const sdkHome = `${androidHome}/sdk_home`;
  core.exportVariable('ANDROID_SDK_HOME', sdkHome);
  if (fs.existsSync(sdkHome)) {
    await exec.exec(`mv ${sdkHome} ${sdkHome}.backup.${Date.now()}`);
  }

  await exec.exec(`curl -L ${baseSdkUrl} -o ${androidTmpPath} -s`);
  await exec.exec(`unzip -q ${androidTmpPath} -d ${androidHome}`);
  await exec.exec(`rm ${androidTmpPath}`);
  await exec.exec(`mkdir -p ${sdkHome}`);

  const path = process.env.PATH || '';
  const extraPaths = `${androidHome}/bin:${androidHome}/tools:${androidHome}/tools/bin:${androidHome}/platform-tools:${androidHome}/platform-tools/bin`;

  // Remove from path any Android previous installation
  const pathWithoutAndroid = path
    .split(':')
    .filter(entry => {
      return !entry.includes('Android');
    })
    .join(':');

  core.exportVariable('PATH', `${extraPaths}:${pathWithoutAndroid}`);
  return true;
}

async function acceptLicenses() {
  const androidHome = process.env.ANDROID_HOME;
  console.log(`Accepting Android SDK licenses on ${androidHome}`);

  await exec.exec(`mkdir -p ${process.env.ANDROID_SDK_HOME}`);
  await exec.exec(`touch ${process.env.ANDROID_SDK_HOME}/repositories.cfg`);
  await exec.exec(`mkdir -p ${androidHome}/licenses`);
  await exec.exec(`sh -c \\"yes 'y' | ${androidHome}/tools/bin/sdkmanager --licenses > /dev/null"`);
  return true;
}
