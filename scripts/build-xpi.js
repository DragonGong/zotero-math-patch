"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const buildsDir = path.join(root, "builds");
const zipPath = path.join(buildsDir, "zotero-math-patch.zip");
const xpiPath = path.join(buildsDir, "zotero-math-patch.xpi");
const entries = ["manifest.json", "install.rdf", "chrome.manifest", "bootstrap.js", "chrome", "README.md"];

fs.rmSync(zipPath, { force: true });
fs.rmSync(xpiPath, { force: true });
fs.mkdirSync(buildsDir, { recursive: true });

const files = entries.flatMap((entry) => collectFiles(path.join(root, entry), entry));

if (process.platform === "win32") {
  runPowerShellArchive(files);
}
else {
  runZipArchive(files);
}

fs.renameSync(zipPath, xpiPath);
console.log("Built " + path.relative(root, xpiPath));

function collectFiles(source, zipName) {
  const stats = fs.statSync(source);
  if (stats.isDirectory()) {
    return fs.readdirSync(source)
      .filter((child) => child !== ".DS_Store")
      .flatMap((child) => collectFiles(path.join(source, child), `${zipName}/${child}`));
  }

  if (path.basename(source) === ".DS_Store") {
    return [];
  }

  return [{
    source,
    zipName: zipName.replace(/\\/g, "/"),
  }];
}

function runPowerShellArchive(files) {
  const archiveScriptPath = path.join(buildsDir, ".build-xpi.ps1");
  const payloadPath = path.join(buildsDir, ".build-xpi-files.json");
  const archiveScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
$files = Get-Content -Raw -LiteralPath $env:XPI_FILE_LIST | ConvertFrom-Json
$stream = [System.IO.File]::Open($env:XPI_OUTPUT, [System.IO.FileMode]::CreateNew)
try {
  $archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($file in $files) {
      $entry = $archive.CreateEntry($file.zipName, [System.IO.Compression.CompressionLevel]::Optimal)
      $entryStream = $entry.Open()
      try {
        $inputStream = [System.IO.File]::OpenRead($file.source)
        try {
          $inputStream.CopyTo($entryStream)
        }
        finally {
          $inputStream.Dispose()
        }
      }
      finally {
        $entryStream.Dispose()
      }
    }
  }
  finally {
    $archive.Dispose()
  }
}
finally {
  $stream.Dispose()
}
`;

  fs.writeFileSync(payloadPath, JSON.stringify(files, null, 2));
  fs.writeFileSync(archiveScriptPath, archiveScript);

  const env = {
    ...process.env,
    XPI_FILE_LIST: payloadPath,
    XPI_OUTPUT: zipPath,
  };
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", archiveScriptPath], {
    cwd: root,
    env,
    stdio: "inherit",
  });

  fs.rmSync(payloadPath, { force: true });
  fs.rmSync(archiveScriptPath, { force: true });

  if (result.status !== 0) {
    throw new Error("PowerShell ZIP creation failed");
  }
}

function runZipArchive(files) {
  const stageDir = path.join(buildsDir, ".xpi-stage");
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  for (const file of files) {
    const target = path.join(stageDir, ...file.zipName.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file.source, target);
  }

  const result = spawnSync("zip", ["-r", zipPath, "."], {
    cwd: stageDir,
    stdio: "inherit",
  });

  fs.rmSync(stageDir, { recursive: true, force: true });

  if (result.status !== 0) {
    throw new Error("zip failed");
  }
}
