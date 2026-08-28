#!/usr/bin/env node

// src/claude-bundle-native.ts
import fs from "fs";
import path from "path";
import os from "os";
import { execSync, execFileSync } from "child_process";
import LIEF from "node-lief";
var debug = (..._args) => {
};
var isDebug = () => false;
var NIX_WRAPPER_MAX_SIZE = 2e5;
function resolveNixBinaryWrapper(binaryPath) {
  try {
    const stat = fs.statSync(binaryPath);
    if (stat.size > NIX_WRAPPER_MAX_SIZE) {
      return null;
    }
    LIEF.logging.disable();
    const binary = LIEF.parse(binaryPath);
    const symbols = binary.symbols();
    const hasExecv = symbols.some((sym) => {
      const name = sym.name;
      return name === "execv" || name === "_execv";
    });
    if (!hasExecv) {
      debug(
        "resolveNixBinaryWrapper: no execv import found, not a Nix wrapper"
      );
      return null;
    }
    debug(
      "resolveNixBinaryWrapper: execv import found, checking for Nix wrapper DOCSTRING"
    );
    let rawBytes = null;
    if (binary.format === "ELF") {
      const rodata = binary.sections().find((s) => s.name === ".rodata");
      if (rodata) {
        rawBytes = rodata.content;
      }
    } else if (binary.format === "MachO") {
      const machoBinary = binary;
      const textSeg = machoBinary.getSegment("__TEXT");
      if (textSeg) {
        const cstring = textSeg.getSection("__cstring");
        if (cstring) {
          rawBytes = cstring.content;
        }
      }
    }
    if (!rawBytes || rawBytes.length === 0) {
      debug("resolveNixBinaryWrapper: could not read string section");
      return null;
    }
    const text = rawBytes.toString("utf-8");
    const docstringMatch = text.match(/makeCWrapper\s+'(\/nix\/store\/[^']+)'/);
    if (docstringMatch) {
      const resolvedPath = docstringMatch[1];
      debug(
        `resolveNixBinaryWrapper: found wrapped executable via DOCSTRING: ${resolvedPath}`
      );
      return resolvedPath;
    }
    const unquotedMatch = text.match(/makeCWrapper\s+(\/nix\/store\/\S+)/);
    if (unquotedMatch) {
      const resolvedPath = unquotedMatch[1];
      debug(
        `resolveNixBinaryWrapper: found wrapped executable via unquoted DOCSTRING: ${resolvedPath}`
      );
      return resolvedPath;
    }
    const nixPaths = text.match(/\/nix\/store\/[^\s]+/g);
    if (nixPaths) {
      for (const p of nixPaths) {
        if (p.includes("/bin/")) {
          debug(
            `resolveNixBinaryWrapper: found wrapped executable via /bin/ heuristic: ${p}`
          );
          return p;
        }
      }
    }
    debug("resolveNixBinaryWrapper: has execv but no Nix store paths found");
    return null;
  } catch (error) {
    debug("resolveNixBinaryWrapper: error during detection:", error);
    return null;
  }
}
var BUN_TRAILER = Buffer.from("\n---- Bun! ----\n");
var BUN_BYTECODE_PREFIX = "// @bun @bytecode";
var BUN_CJS_MARKER = "@bun-cjs";
var SIZEOF_OFFSETS = 32;
var SIZEOF_STRING_POINTER = 8;
var SIZEOF_MODULE_OLD = 4 * SIZEOF_STRING_POINTER + 4;
var SIZEOF_MODULE_NEW = 6 * SIZEOF_STRING_POINTER + 4;
function getStringPointerContent(buffer, stringPointer) {
  return buffer.subarray(
    stringPointer.offset,
    stringPointer.offset + stringPointer.length
  );
}
function parseStringPointer(buffer, offset) {
  return {
    offset: buffer.readUInt32LE(offset),
    length: buffer.readUInt32LE(offset + 4)
  };
}
function isClaudeModule(moduleName) {
  const normalizedName = moduleName.replaceAll("\\", "/");
  return normalizedName.endsWith("/claude") || normalizedName === "claude" || normalizedName.endsWith("/claude.exe") || normalizedName === "claude.exe" || normalizedName.endsWith("/src/entrypoints/cli.js") || normalizedName === "src/entrypoints/cli.js" || normalizedName === "/$bunfs/root/cli" || normalizedName === "B:/~BUN/root/cli" || normalizedName === "cli";
}
function isChunkModule(moduleName) {
  return /(^|[\\/])chunk-[^\\/]+\.js$/.test(moduleName);
}
var CLAUDE_MODULE_BOUNDARY = "\n//#__leverframe_claude_module__:";
function splitModulePayload(content) {
  if (!content.startsWith(CLAUDE_MODULE_BOUNDARY)) return null;
  return content.split(CLAUDE_MODULE_BOUNDARY).slice(1).map((segment) => {
    const nameEnd = segment.indexOf("\n");
    if (nameEnd === -1) throw new Error("Malformed Leverframe Claude module boundary");
    return [segment.slice(0, nameEnd), segment.slice(nameEnd + 1)];
  });
}
function summarizeNames(names) {
  const shown = names.slice(0, 5).join(", ");
  return names.length > 5 ? `${shown}, ... (${names.length} total)` : shown;
}
function buildModuleReplacements(parts, expectedNames) {
  const replacements = /* @__PURE__ */ new Map();
  const duplicates = [];
  for (const [name, body] of parts) {
    if (replacements.has(name)) duplicates.push(name);
    replacements.set(name, Buffer.from(body));
  }
  if (duplicates.length) throw new Error(`Module payload names a module more than once: ${summarizeNames(duplicates)}`);
  const expected = new Set(expectedNames);
  const unknown = [...replacements.keys()].filter((name) => !expected.has(name));
  if (unknown.length) throw new Error(`Module payload names ${unknown.length} module(s) absent from the binary: ${summarizeNames(unknown)}`);
  const missing = expectedNames.filter((name) => !replacements.has(name));
  if (missing.length) throw new Error(`Module payload is missing ${missing.length} module(s) present in the binary: ${summarizeNames(missing)}`);
  return replacements;
}
function bytecodeForReplacement(original, replacement, bytecode) {
  return original.equals(replacement) ? bytecode : Buffer.alloc(0);
}
function sourceForInvalidatedBytecode(source) {
  if (!source.subarray(0, BUN_BYTECODE_PREFIX.length).equals(Buffer.from(BUN_BYTECODE_PREFIX))) {
    return source;
  }
  const newline = source.indexOf(10);
  return newline === -1 ? Buffer.alloc(0) : source.subarray(newline + 1);
}
function detectModuleStructSize(modulesListLength) {
  const fitsNew = modulesListLength % SIZEOF_MODULE_NEW === 0;
  const fitsOld = modulesListLength % SIZEOF_MODULE_OLD === 0;
  if (fitsNew && !fitsOld) return SIZEOF_MODULE_NEW;
  if (fitsOld && !fitsNew) return SIZEOF_MODULE_OLD;
  if (fitsNew && fitsOld) {
    debug(
      `detectModuleStructSize: Ambiguous module list length ${modulesListLength}, assuming new format`
    );
    return SIZEOF_MODULE_NEW;
  }
  debug(
    `detectModuleStructSize: Module list length ${modulesListLength} doesn't cleanly divide by either struct size, assuming new format`
  );
  return SIZEOF_MODULE_NEW;
}
function mapModules(bunData, bunOffsets, moduleStructSize, visitor) {
  const modulesListBytes = getStringPointerContent(
    bunData,
    bunOffsets.modulesPtr
  );
  const modulesListCount = Math.floor(
    modulesListBytes.length / moduleStructSize
  );
  for (let i = 0; i < modulesListCount; i++) {
    const offset = i * moduleStructSize;
    const module = parseCompiledModuleGraphFile(
      modulesListBytes,
      offset,
      moduleStructSize
    );
    const moduleName = getStringPointerContent(bunData, module.name).toString(
      "utf-8"
    );
    const result = visitor(module, moduleName, i);
    if (result !== void 0) {
      return result;
    }
  }
  return void 0;
}
function collectClaudeJavaScriptModules(bunData, bunOffsets, moduleStructSize) {
  const modules = [];
  mapModules(bunData, bunOffsets, moduleStructSize, (module, name) => {
    if (!isClaudeModule(name) && !isChunkModule(name)) return void 0;
    const content = getStringPointerContent(bunData, module.contents);
    if (content.length) modules.push([name, content]);
    return void 0;
  });
  return modules;
}
function parseOffsets(buffer) {
  let pos = 0;
  const byteCount = buffer.readBigUInt64LE(pos);
  pos += 8;
  const modulesPtr = parseStringPointer(buffer, pos);
  pos += 8;
  const entryPointId = buffer.readUInt32LE(pos);
  pos += 4;
  const compileExecArgvPtr = parseStringPointer(buffer, pos);
  pos += 8;
  const flags = buffer.readUInt32LE(pos);
  return { byteCount, modulesPtr, entryPointId, compileExecArgvPtr, flags };
}
function parseCompiledModuleGraphFile(buffer, offset, moduleStructSize) {
  let pos = offset;
  const name = parseStringPointer(buffer, pos);
  pos += 8;
  const contents = parseStringPointer(buffer, pos);
  pos += 8;
  const sourcemap = parseStringPointer(buffer, pos);
  pos += 8;
  const bytecode = parseStringPointer(buffer, pos);
  pos += 8;
  let moduleInfo;
  let bytecodeOriginPath;
  if (moduleStructSize === SIZEOF_MODULE_NEW) {
    moduleInfo = parseStringPointer(buffer, pos);
    pos += 8;
    bytecodeOriginPath = parseStringPointer(buffer, pos);
    pos += 8;
  } else {
    moduleInfo = { offset: 0, length: 0 };
    bytecodeOriginPath = { offset: 0, length: 0 };
  }
  const encoding = buffer.readUInt8(pos);
  pos += 1;
  const loader = buffer.readUInt8(pos);
  pos += 1;
  const moduleFormat = buffer.readUInt8(pos);
  pos += 1;
  const side = buffer.readUInt8(pos);
  return {
    name,
    contents,
    sourcemap,
    bytecode,
    moduleInfo,
    bytecodeOriginPath,
    encoding,
    loader,
    moduleFormat,
    side
  };
}
function parseBunDataBlob(bunDataContent) {
  if (bunDataContent.length < SIZEOF_OFFSETS + BUN_TRAILER.length) {
    throw new Error("BUN data is too small to contain trailer and offsets");
  }
  const trailerStart = bunDataContent.length - BUN_TRAILER.length;
  const trailerBytes = bunDataContent.subarray(trailerStart);
  debug(`parseBunDataBlob: Expected trailer: ${BUN_TRAILER.toString("hex")}`);
  debug(`parseBunDataBlob: Got trailer: ${trailerBytes.toString("hex")}`);
  if (!trailerBytes.equals(BUN_TRAILER)) {
    throw new Error("BUN trailer bytes do not match trailer");
  }
  const offsetsStart = bunDataContent.length - SIZEOF_OFFSETS - BUN_TRAILER.length;
  const offsetsBytes = bunDataContent.subarray(
    offsetsStart,
    offsetsStart + SIZEOF_OFFSETS
  );
  const bunOffsets = parseOffsets(offsetsBytes);
  const moduleStructSize = detectModuleStructSize(bunOffsets.modulesPtr.length);
  return {
    bunOffsets,
    bunData: bunDataContent,
    moduleStructSize
  };
}
function extractBunDataFromSection(sectionData) {
  if (sectionData.length < 4) {
    throw new Error("Section data too small");
  }
  debug(`extractBunDataFromSection: sectionData.length=${sectionData.length}`);
  const bunDataSizeU32 = sectionData.readUInt32LE(0);
  const expectedLengthU32 = 4 + bunDataSizeU32;
  const bunDataSizeU64 = sectionData.length >= 8 ? Number(sectionData.readBigUInt64LE(0)) : 0;
  const expectedLengthU64 = 8 + bunDataSizeU64;
  debug(
    `extractBunDataFromSection: u32 header would give size=${bunDataSizeU32}, expected total=${expectedLengthU32}`
  );
  debug(
    `extractBunDataFromSection: u64 header would give size=${bunDataSizeU64}, expected total=${expectedLengthU64}`
  );
  let headerSize;
  let bunDataSize;
  if (sectionData.length >= 8 && expectedLengthU64 <= sectionData.length && expectedLengthU64 >= sectionData.length - 4096) {
    headerSize = 8;
    bunDataSize = bunDataSizeU64;
    debug(
      `extractBunDataFromSection: detected u64 header format (Bun >= 1.3.4)`
    );
  } else if (expectedLengthU32 <= sectionData.length && expectedLengthU32 >= sectionData.length - 4096) {
    headerSize = 4;
    bunDataSize = bunDataSizeU32;
    debug(
      `extractBunDataFromSection: detected u32 header format (Bun < 1.3.4)`
    );
  } else {
    throw new Error(
      `Cannot determine section header format: sectionData.length=${sectionData.length}, u64 would expect ${expectedLengthU64}, u32 would expect ${expectedLengthU32}`
    );
  }
  debug(`extractBunDataFromSection: bunDataSize from header=${bunDataSize}`);
  const bunDataContent = sectionData.subarray(
    headerSize,
    headerSize + bunDataSize
  );
  debug(
    `extractBunDataFromSection: bunDataContent.length=${bunDataContent.length}`
  );
  const { bunOffsets, bunData, moduleStructSize } = parseBunDataBlob(bunDataContent);
  return {
    bunOffsets,
    bunData,
    sectionHeaderSize: headerSize,
    moduleStructSize
  };
}
function extractBunDataFromELFSection(elfBinary) {
  try {
    const bunSection = elfBinary.getSection(".bun");
    if (!bunSection) {
      debug("extractBunDataFromELFSection: .bun section not found");
      return null;
    }
    const sectionContent = bunSection.content;
    if (sectionContent.length < 8) {
      debug("extractBunDataFromELFSection: .bun section too small");
      return null;
    }
    debug(
      `extractBunDataFromELFSection: .bun section found, size=${sectionContent.length}`
    );
    const result = extractBunDataFromSection(sectionContent);
    debug("extractBunDataFromELFSection: successfully extracted data");
    return result;
  } catch (error) {
    debug("extractBunDataFromELFSection: failed to extract:", error);
    return null;
  }
}
function extractBunDataFromELFOverlay(elfBinary) {
  if (!elfBinary.hasOverlay) {
    throw new Error("ELF binary has no overlay data");
  }
  const overlayData = elfBinary.overlay;
  debug(
    `extractBunDataFromELFOverlay: Overlay size=${overlayData.length} bytes`
  );
  if (overlayData.length < BUN_TRAILER.length + 8 + SIZEOF_OFFSETS) {
    throw new Error("ELF overlay data is too small");
  }
  const totalByteCount = overlayData.readBigUInt64LE(overlayData.length - 8);
  debug(
    `extractBunDataFromELFOverlay: Total byte count from tail=${totalByteCount}`
  );
  if (totalByteCount < 4096n || totalByteCount > 2n ** 32n - 1n) {
    throw new Error(`ELF total byte count is out of range: ${totalByteCount}`);
  }
  const trailerStart = overlayData.length - 8 - BUN_TRAILER.length;
  const trailerBytes = overlayData.subarray(
    trailerStart,
    overlayData.length - 8
  );
  debug(
    `extractBunDataFromELFOverlay: Expected trailer: ${BUN_TRAILER.toString("hex")}`
  );
  debug(
    `extractBunDataFromELFOverlay: Got trailer: ${trailerBytes.toString("hex")}`
  );
  if (!trailerBytes.equals(BUN_TRAILER)) {
    throw new Error("BUN trailer bytes do not match trailer");
  }
  const offsetsStart = overlayData.length - 8 - BUN_TRAILER.length - SIZEOF_OFFSETS;
  const offsetsBytes = overlayData.subarray(
    offsetsStart,
    overlayData.length - 8 - BUN_TRAILER.length
  );
  const bunOffsets = parseOffsets(offsetsBytes);
  debug(
    `extractBunDataFromELFOverlay: Offsets.byteCount=${bunOffsets.byteCount}`
  );
  const byteCount = typeof bunOffsets.byteCount === "bigint" ? bunOffsets.byteCount : BigInt(bunOffsets.byteCount);
  if (byteCount >= totalByteCount) {
    throw new Error("ELF total byte count is out of range");
  }
  const tailDataLen = 8 + BUN_TRAILER.length + SIZEOF_OFFSETS;
  const dataStart = overlayData.length - tailDataLen - Number(byteCount);
  const dataRegion = overlayData.subarray(
    dataStart,
    overlayData.length - tailDataLen
  );
  debug(
    `extractBunDataFromELFOverlay: Extracted ${dataRegion.length} bytes of data`
  );
  const bunDataBlob = Buffer.concat([dataRegion, offsetsBytes, trailerBytes]);
  const moduleStructSize = detectModuleStructSize(bunOffsets.modulesPtr.length);
  return {
    bunOffsets,
    bunData: bunDataBlob,
    moduleStructSize
  };
}
function extractBunDataFromMachO(machoBinary) {
  const bunSegment = machoBinary.getSegment("__BUN");
  if (!bunSegment) {
    throw new Error("__BUN segment not found");
  }
  const bunSection = bunSegment.getSection("__bun");
  if (!bunSection) {
    throw new Error("__bun section not found");
  }
  return extractBunDataFromSection(bunSection.content);
}
function extractBunDataFromPE(peBinary) {
  const bunSection = peBinary.sections().find((s) => s.name === ".bun");
  if (!bunSection) {
    throw new Error(".bun section not found");
  }
  return extractBunDataFromSection(bunSection.content);
}
function getExpectedFormatForPlatform() {
  switch (process.platform) {
    case "darwin":
      return "MachO";
    case "linux":
      return "ELF";
    case "win32":
      return "PE";
    default:
      return null;
  }
}
function assertPlatformFormat(binary) {
  const expectedFormat = getExpectedFormatForPlatform();
  if (expectedFormat && binary.format !== expectedFormat) {
    throw new Error(
      `Native binary format ${binary.format} does not match ${process.platform} (${expectedFormat})`
    );
  }
}
function locateBundle(binary, binPath) {
  debug(`locateBundle: Binary format detected as ${binary.format}`);
  assertPlatformFormat(binary);
  switch (binary.format) {
    case "MachO": {
      const machoBinary = binary;
      const data = extractBunDataFromMachO(machoBinary);
      if (!data.sectionHeaderSize) {
        throw new Error("sectionHeaderSize is required for Mach-O binaries");
      }
      const bunSection = machoBinary.getSegment("__BUN").getSection("__bun");
      return {
        ...data,
        offset: Number(bunSection.fileOffset),
        length: bunSection.content.length,
        write: (newBunBuffer, outputPath) => repackMachO(
          machoBinary,
          binPath,
          newBunBuffer,
          outputPath,
          data.sectionHeaderSize
        )
      };
    }
    case "PE": {
      const peBinary = binary;
      const data = extractBunDataFromPE(peBinary);
      if (!data.sectionHeaderSize) {
        throw new Error("sectionHeaderSize is required for PE binaries");
      }
      const bunSection = peBinary.sections().find((s) => s.name === ".bun");
      return {
        ...data,
        offset: Number(bunSection.fileOffset),
        length: bunSection.content.length,
        write: (newBunBuffer, outputPath) => repackPE(
          peBinary,
          binPath,
          newBunBuffer,
          outputPath,
          data.sectionHeaderSize
        )
      };
    }
    case "ELF": {
      const elfBinary = binary;
      const sectionResult = extractBunDataFromELFSection(elfBinary);
      if (sectionResult) {
        debug("locateBundle: Using new ELF .bun section format");
        if (!sectionResult.sectionHeaderSize) {
          throw new Error("sectionHeaderSize is required for ELF .bun section");
        }
        return {
          ...sectionResult,
          offset: Number(elfBinary.getSection(".bun").fileOffset),
          length: elfBinary.getSection(".bun").content.length,
          write: (newBunBuffer, outputPath) => repackELFSection(
            elfBinary,
            binPath,
            newBunBuffer,
            outputPath,
            sectionResult.sectionHeaderSize
          )
        };
      }
      debug("locateBundle: Falling back to legacy ELF overlay format");
      const data = extractBunDataFromELFOverlay(elfBinary);
      const stat = fs.statSync(binPath);
      return {
        ...data,
        offset: stat.size - elfBinary.overlay.length,
        length: elfBinary.overlay.length,
        write: (newBunBuffer, outputPath) => repackELFOverlay(elfBinary, binPath, newBunBuffer, outputPath)
      };
    }
    default: {
      const _exhaustive = binary;
      throw new Error(
        `Unsupported binary format: ${_exhaustive.format}`
      );
    }
  }
}
function fetchNpmSource(version) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "leverframe-claude-"));
  try {
    debug(`fetchNpmSource: Downloading @anthropic-ai/claude-code@${version}`);
    execFileSync(
      "npm",
      [
        "pack",
        `@anthropic-ai/claude-code@${version}`,
        "--pack-destination",
        tmpDir
      ],
      { stdio: "pipe", timeout: 3e4, cwd: tmpDir }
    );
    const files = fs.readdirSync(tmpDir);
    const tgz = files.find((f) => f.endsWith(".tgz"));
    if (!tgz) {
      debug("fetchNpmSource: No .tgz file found after npm pack");
      return null;
    }
    execFileSync("tar", ["xzf", path.join(tmpDir, tgz), "package/cli.js"], {
      stdio: "pipe",
      timeout: 3e4,
      cwd: tmpDir
    });
    const cliJsPath = path.join(tmpDir, "package", "cli.js");
    if (!fs.existsSync(cliJsPath)) {
      debug("fetchNpmSource: cli.js not found in extracted package");
      return null;
    }
    const content = fs.readFileSync(cliJsPath);
    debug(`fetchNpmSource: Got cli.js, ${content.length} bytes`);
    return content;
  } catch (error) {
    debug("fetchNpmSource: Failed to fetch npm source:", error);
    return null;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
    }
  }
}
function extractClaudeJsFromNativeInstallation(nativeInstallationPath, version) {
  try {
    LIEF.logging.disable();
    const binary = LIEF.parse(nativeInstallationPath);
    const { bunOffsets, bunData, moduleStructSize } = locateBundle(
      binary,
      nativeInstallationPath
    );
    debug(
      `extractClaudeJsFromNativeInstallation: Got bunData, size=${bunData.length} bytes, moduleStructSize=${moduleStructSize}`
    );
    const jsModules = collectClaudeJavaScriptModules(
      bunData,
      bunOffsets,
      moduleStructSize
    );
    let result;
    if (jsModules.length === 1) {
      result = jsModules[0][1];
    } else if (jsModules.length > 1) {
      for (const [name, content] of jsModules) {
        if (content.includes(CLAUDE_MODULE_BOUNDARY)) {
          throw new Error(`Claude module ${name} contains the reserved integration boundary`);
        }
      }
      result = Buffer.from(jsModules.map(
        ([name, content]) => `${CLAUDE_MODULE_BOUNDARY}${name}
${content.toString("utf8")}`
      ).join(""));
    }
    if (result) {
      const head = result.subarray(0, 64).toString("utf8");
      if (head.startsWith(BUN_BYTECODE_PREFIX) && !head.includes(BUN_CJS_MARKER)) {
        debug(
          "extractClaudeJsFromNativeInstallation: Extracted content is Bun bytecode \u2014 falling back to npm source"
        );
        if (version) {
          const npmSource = fetchNpmSource(version);
          if (npmSource) {
            debug(
              `extractClaudeJsFromNativeInstallation: Using npm source (${npmSource.length} bytes) instead of bytecode`
            );
            return { data: npmSource, clearBytecode: true };
          }
          debug(
            "extractClaudeJsFromNativeInstallation: npm source fetch failed, returning bytecode content as-is"
          );
        } else {
          debug(
            "extractClaudeJsFromNativeInstallation: No version provided, cannot fetch npm source"
          );
        }
      }
      return { data: result, clearBytecode: false };
    }
    debug(
      "extractClaudeJsFromNativeInstallation: claude module not found in any module"
    );
    return {
      data: null,
      clearBytecode: false,
      error: "claude module not found in any of the binary modules"
    };
  } catch (error) {
    debug(
      "extractClaudeJsFromNativeInstallation: Error during extraction:",
      error
    );
    return {
      data: null,
      clearBytecode: false,
      error: `extraction threw: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
function rebuildBunData(bunData, bunOffsets, modifiedClaudeJs, moduleStructSize, clearBytecode) {
  if (modifiedClaudeJs instanceof Map) {
    return rebuildBunDataPreservingLayout(
      bunData,
      bunOffsets,
      modifiedClaudeJs,
      moduleStructSize
    );
  }
  const stringsData = [];
  const modulesMetadata = [];
  mapModules(bunData, bunOffsets, moduleStructSize, (module, moduleName) => {
    const nameBytes = getStringPointerContent(bunData, module.name);
    let contentsBytes;
    let bytecodeBytes;
    if (modifiedClaudeJs instanceof Map && modifiedClaudeJs.has(moduleName)) {
      const originalContents = getStringPointerContent(bunData, module.contents);
      contentsBytes = modifiedClaudeJs.get(moduleName);
      bytecodeBytes = bytecodeForReplacement(
        originalContents,
        contentsBytes,
        getStringPointerContent(bunData, module.bytecode)
      );
    } else if (modifiedClaudeJs instanceof Buffer && isClaudeModule(moduleName)) {
      contentsBytes = modifiedClaudeJs;
      bytecodeBytes = clearBytecode ? Buffer.alloc(0) : getStringPointerContent(bunData, module.bytecode);
    } else {
      contentsBytes = getStringPointerContent(bunData, module.contents);
      bytecodeBytes = getStringPointerContent(bunData, module.bytecode);
    }
    const sourcemapBytes = getStringPointerContent(bunData, module.sourcemap);
    const moduleInfoBytes = getStringPointerContent(bunData, module.moduleInfo);
    const bytecodeOriginPathBytes = getStringPointerContent(
      bunData,
      module.bytecodeOriginPath
    );
    modulesMetadata.push({
      name: nameBytes,
      contents: contentsBytes,
      sourcemap: sourcemapBytes,
      bytecode: bytecodeBytes,
      moduleInfo: moduleInfoBytes,
      bytecodeOriginPath: bytecodeOriginPathBytes,
      encoding: module.encoding,
      loader: module.loader,
      moduleFormat: module.moduleFormat,
      side: module.side
    });
    if (moduleStructSize === SIZEOF_MODULE_NEW) {
      stringsData.push(
        nameBytes,
        contentsBytes,
        sourcemapBytes,
        bytecodeBytes,
        moduleInfoBytes,
        bytecodeOriginPathBytes
      );
    } else {
      stringsData.push(nameBytes, contentsBytes, sourcemapBytes, bytecodeBytes);
    }
    return void 0;
  });
  const stringsPerModule = moduleStructSize === SIZEOF_MODULE_NEW ? 6 : 4;
  let currentOffset = 0;
  const stringOffsets = [];
  for (const stringData of stringsData) {
    stringOffsets.push({ offset: currentOffset, length: stringData.length });
    currentOffset += stringData.length + 1;
  }
  const modulesListOffset = currentOffset;
  const modulesListSize = modulesMetadata.length * moduleStructSize;
  currentOffset += modulesListSize;
  const compileExecArgvBytes = getStringPointerContent(
    bunData,
    bunOffsets.compileExecArgvPtr
  );
  const compileExecArgvOffset = currentOffset;
  const compileExecArgvLength = compileExecArgvBytes.length;
  currentOffset += compileExecArgvLength + 1;
  const offsetsOffset = currentOffset;
  currentOffset += SIZEOF_OFFSETS;
  const trailerOffset = currentOffset;
  currentOffset += BUN_TRAILER.length;
  const newBuffer = Buffer.allocUnsafe(currentOffset);
  newBuffer.fill(0);
  let stringIdx = 0;
  for (const { offset, length } of stringOffsets) {
    if (length > 0) {
      stringsData[stringIdx].copy(newBuffer, offset, 0, length);
    }
    newBuffer[offset + length] = 0;
    stringIdx++;
  }
  if (compileExecArgvLength > 0) {
    compileExecArgvBytes.copy(
      newBuffer,
      compileExecArgvOffset,
      0,
      compileExecArgvLength
    );
    newBuffer[compileExecArgvOffset + compileExecArgvLength] = 0;
  }
  for (let i = 0; i < modulesMetadata.length; i++) {
    const metadata = modulesMetadata[i];
    const baseStringIdx = i * stringsPerModule;
    const moduleStruct = {
      name: stringOffsets[baseStringIdx],
      contents: stringOffsets[baseStringIdx + 1],
      sourcemap: stringOffsets[baseStringIdx + 2],
      bytecode: stringOffsets[baseStringIdx + 3],
      moduleInfo: moduleStructSize === SIZEOF_MODULE_NEW ? stringOffsets[baseStringIdx + 4] : { offset: 0, length: 0 },
      bytecodeOriginPath: moduleStructSize === SIZEOF_MODULE_NEW ? stringOffsets[baseStringIdx + 5] : { offset: 0, length: 0 },
      encoding: metadata.encoding,
      loader: metadata.loader,
      moduleFormat: metadata.moduleFormat,
      side: metadata.side
    };
    const moduleOffset = modulesListOffset + i * moduleStructSize;
    let pos = moduleOffset;
    newBuffer.writeUInt32LE(moduleStruct.name.offset, pos);
    newBuffer.writeUInt32LE(moduleStruct.name.length, pos + 4);
    pos += 8;
    newBuffer.writeUInt32LE(moduleStruct.contents.offset, pos);
    newBuffer.writeUInt32LE(moduleStruct.contents.length, pos + 4);
    pos += 8;
    newBuffer.writeUInt32LE(moduleStruct.sourcemap.offset, pos);
    newBuffer.writeUInt32LE(moduleStruct.sourcemap.length, pos + 4);
    pos += 8;
    newBuffer.writeUInt32LE(moduleStruct.bytecode.offset, pos);
    newBuffer.writeUInt32LE(moduleStruct.bytecode.length, pos + 4);
    pos += 8;
    if (moduleStructSize === SIZEOF_MODULE_NEW) {
      newBuffer.writeUInt32LE(moduleStruct.moduleInfo.offset, pos);
      newBuffer.writeUInt32LE(moduleStruct.moduleInfo.length, pos + 4);
      pos += 8;
      newBuffer.writeUInt32LE(moduleStruct.bytecodeOriginPath.offset, pos);
      newBuffer.writeUInt32LE(moduleStruct.bytecodeOriginPath.length, pos + 4);
      pos += 8;
    }
    newBuffer.writeUInt8(moduleStruct.encoding, pos);
    newBuffer.writeUInt8(moduleStruct.loader, pos + 1);
    newBuffer.writeUInt8(moduleStruct.moduleFormat, pos + 2);
    newBuffer.writeUInt8(moduleStruct.side, pos + 3);
  }
  const newOffsets = {
    byteCount: offsetsOffset,
    modulesPtr: {
      offset: modulesListOffset,
      length: modulesListSize
    },
    entryPointId: bunOffsets.entryPointId,
    compileExecArgvPtr: {
      offset: compileExecArgvOffset,
      length: compileExecArgvLength
    },
    flags: bunOffsets.flags
  };
  let offsetsPos = offsetsOffset;
  const byteCount = typeof newOffsets.byteCount === "bigint" ? newOffsets.byteCount : BigInt(newOffsets.byteCount);
  newBuffer.writeBigUInt64LE(byteCount, offsetsPos);
  offsetsPos += 8;
  newBuffer.writeUInt32LE(newOffsets.modulesPtr.offset, offsetsPos);
  newBuffer.writeUInt32LE(newOffsets.modulesPtr.length, offsetsPos + 4);
  offsetsPos += 8;
  newBuffer.writeUInt32LE(newOffsets.entryPointId, offsetsPos);
  offsetsPos += 4;
  newBuffer.writeUInt32LE(newOffsets.compileExecArgvPtr.offset, offsetsPos);
  newBuffer.writeUInt32LE(newOffsets.compileExecArgvPtr.length, offsetsPos + 4);
  offsetsPos += 8;
  newBuffer.writeUInt32LE(newOffsets.flags, offsetsPos);
  BUN_TRAILER.copy(newBuffer, trailerOffset);
  return newBuffer;
}
function rebuildBunDataPreservingLayout(bunData, bunOffsets, replacements, moduleStructSize) {
  const originalDataLength = Number(bunOffsets.byteCount);
  const modulesList = getStringPointerContent(bunData, bunOffsets.modulesPtr);
  const selected = [];
  mapModules(bunData, bunOffsets, moduleStructSize, (module, name, index) => {
    const replacement = replacements.get(name);
    if (replacement) selected.push({
      index,
      original: getStringPointerContent(bunData, module.contents),
      replacement
    });
    return void 0;
  });
  if (!selected.some((item) => !item.replacement.equals(item.original))) return bunData;
  const changed = selected.map(({ index, replacement }) => ({
    index,
    contents: sourceForInvalidatedBytecode(replacement)
  }));
  const appendedContentsLength = changed.reduce(
    (total, item) => total + item.contents.length + 1,
    0
  );
  const newModulesOffset = originalDataLength + appendedContentsLength;
  const newOffsetsOffset = newModulesOffset + modulesList.length;
  const newBuffer = Buffer.alloc(
    newOffsetsOffset + SIZEOF_OFFSETS + BUN_TRAILER.length
  );
  bunData.copy(newBuffer, 0, 0, originalDataLength);
  const newModules = Buffer.from(modulesList);
  let contentsOffset = originalDataLength;
  for (const { index, contents } of changed) {
    contents.copy(newBuffer, contentsOffset);
    newBuffer[contentsOffset + contents.length] = 0;
    const moduleOffset = index * moduleStructSize;
    newModules.writeUInt32LE(contentsOffset, moduleOffset + 8);
    newModules.writeUInt32LE(contents.length, moduleOffset + 12);
    newModules.writeUInt32LE(0, moduleOffset + 24);
    newModules.writeUInt32LE(0, moduleOffset + 28);
    if (moduleStructSize === SIZEOF_MODULE_NEW) {
      newModules.writeUInt32LE(0, moduleOffset + 32);
      newModules.writeUInt32LE(0, moduleOffset + 36);
      newModules.writeUInt32LE(0, moduleOffset + 40);
      newModules.writeUInt32LE(0, moduleOffset + 44);
    }
    contentsOffset += contents.length + 1;
  }
  newModules.copy(newBuffer, newModulesOffset);
  let offsetsPos = newOffsetsOffset;
  newBuffer.writeBigUInt64LE(BigInt(newOffsetsOffset), offsetsPos);
  offsetsPos += 8;
  newBuffer.writeUInt32LE(newModulesOffset, offsetsPos);
  newBuffer.writeUInt32LE(modulesList.length, offsetsPos + 4);
  offsetsPos += 8;
  newBuffer.writeUInt32LE(bunOffsets.entryPointId, offsetsPos);
  offsetsPos += 4;
  newBuffer.writeUInt32LE(bunOffsets.compileExecArgvPtr.offset, offsetsPos);
  newBuffer.writeUInt32LE(bunOffsets.compileExecArgvPtr.length, offsetsPos + 4);
  offsetsPos += 8;
  newBuffer.writeUInt32LE(bunOffsets.flags, offsetsPos);
  BUN_TRAILER.copy(newBuffer, newOffsetsOffset + SIZEOF_OFFSETS);
  return newBuffer;
}
function atomicWriteBinary(binary, outputPath, originalPath, copyPermissions = true) {
  const tempPath = outputPath + ".tmp";
  binary.write(tempPath);
  if (copyPermissions) {
    const origStat = fs.statSync(originalPath);
    fs.chmodSync(tempPath, origStat.mode);
  }
  try {
    fs.renameSync(tempPath, outputPath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
    }
    if (error instanceof Error && "code" in error && (error.code === "ETXTBSY" || error.code === "EBUSY" || error.code === "EPERM")) {
      throw new Error(
        "Cannot update the Claude executable while it is running.\nPlease close all Claude instances and try again."
      );
    }
    throw error;
  }
}
function buildSectionData(bunBuffer, headerSize = 8) {
  const sectionData = Buffer.allocUnsafe(headerSize + bunBuffer.length);
  if (headerSize === 8) {
    sectionData.writeBigUInt64LE(BigInt(bunBuffer.length), 0);
  } else {
    sectionData.writeUInt32LE(bunBuffer.length, 0);
  }
  bunBuffer.copy(sectionData, headerSize);
  return sectionData;
}
function repackMachO(machoBinary, binPath, newBunBuffer, outputPath, sectionHeaderSize) {
  try {
    debug(`repackMachO: Has code signature: ${machoBinary.hasCodeSignature}`);
    if (machoBinary.hasCodeSignature) {
      debug("repackMachO: Removing code signature...");
      machoBinary.removeSignature();
    }
    const bunSegment = machoBinary.getSegment("__BUN");
    if (!bunSegment) {
      throw new Error("__BUN segment not found");
    }
    const bunSection = bunSegment.getSection("__bun");
    if (!bunSection) {
      throw new Error("__bun section not found");
    }
    const newSectionData = buildSectionData(newBunBuffer, sectionHeaderSize);
    debug(`repackMachO: Original section size: ${bunSection.size}`);
    debug(`repackMachO: Original segment fileSize: ${bunSegment.fileSize}`);
    debug(
      `repackMachO: Original segment virtualSize: ${bunSegment.virtualSize}`
    );
    debug(`repackMachO: New data size: ${newSectionData.length}`);
    debug(`repackMachO: Using header size: ${sectionHeaderSize}`);
    const sizeDiff = newSectionData.length - Number(bunSection.size);
    if (sizeDiff > 0) {
      const isARM64 = machoBinary.header.cpuType === LIEF.MachO.Header.CPU_TYPE.ARM64;
      const PAGE_SIZE = isARM64 ? 16384 : 4096;
      const alignedSizeDiff = Math.ceil(sizeDiff / PAGE_SIZE) * PAGE_SIZE;
      debug(`repackMachO: CPU type: ${isARM64 ? "ARM64" : "x86_64"}`);
      debug(`repackMachO: Page size: ${PAGE_SIZE} bytes`);
      debug(`repackMachO: Need to expand by ${sizeDiff} bytes`);
      debug(
        `repackMachO: Rounding up to page-aligned: ${alignedSizeDiff} bytes`
      );
      const success = machoBinary.extendSegment(bunSegment, alignedSizeDiff);
      debug(`repackMachO: extendSegment returned: ${success}`);
      if (!success) {
        throw new Error("Failed to extend __BUN segment");
      }
      debug(`repackMachO: Section size after extend: ${bunSection.size}`);
      debug(
        `repackMachO: Segment fileSize after extend: ${bunSegment.fileSize}`
      );
      debug(
        `repackMachO: Segment virtualSize after extend: ${bunSegment.virtualSize}`
      );
    }
    bunSection.content = newSectionData;
    bunSection.size = BigInt(newSectionData.length);
    debug(`repackMachO: Final section size: ${bunSection.size}`);
    debug(`repackMachO: Writing modified binary to ${outputPath}...`);
    atomicWriteBinary(machoBinary, outputPath, binPath);
    try {
      debug(`repackMachO: Re-signing binary with ad-hoc signature...`);
      execSync(`codesign -s - -f "${outputPath}"`, {
        stdio: isDebug() ? "inherit" : "ignore"
      });
      debug("repackMachO: Code signing completed successfully");
    } catch (codesignError) {
      console.warn(
        "Warning: Failed to re-sign binary. The binary may not run correctly on macOS:",
        codesignError
      );
    }
    debug("repackMachO: Write completed successfully");
  } catch (error) {
    console.error("repackMachO failed:", error);
    throw error;
  }
}
function repackPE(peBinary, binPath, newBunBuffer, outputPath, sectionHeaderSize) {
  try {
    const bunSection = peBinary.sections().find((s) => s.name === ".bun");
    if (!bunSection) {
      throw new Error(".bun section not found");
    }
    const newSectionData = buildSectionData(newBunBuffer, sectionHeaderSize);
    debug(
      `repackPE: Original section size: ${bunSection.size}, virtual size: ${bunSection.virtualSize}`
    );
    debug(`repackPE: New data size: ${newSectionData.length}`);
    debug(`repackPE: Using header size: ${sectionHeaderSize}`);
    bunSection.content = newSectionData;
    bunSection.virtualSize = BigInt(newSectionData.length);
    bunSection.size = BigInt(newSectionData.length);
    debug(`repackPE: Writing modified binary to ${outputPath}...`);
    atomicWriteBinary(peBinary, outputPath, binPath, false);
    debug("repackPE: Write completed successfully");
  } catch (error) {
    console.error("repackPE failed:", error);
    throw error;
  }
}
var BLOB_HEADER_ALIGNMENT = 16384;
function alignBigInt(value, alignment) {
  return (value + alignment - 1n) / alignment * alignment;
}
function computeBunSectionPlacement(params) {
  const {
    rwVirtualAddress,
    rwVirtualSize,
    rwFileOffset,
    rwFileSize,
    topmostLoadEnd,
    nextVirtualAddress,
    newContentSize,
    pageSize
  } = params;
  const alignedNewSize = alignBigInt(newContentSize, pageSize);
  const rwMemEnd = rwVirtualAddress + rwVirtualSize;
  const compact = rwMemEnd >= topmostLoadEnd;
  const newVaddr = compact ? alignBigInt(rwMemEnd, pageSize) : alignBigInt(nextVirtualAddress, pageSize);
  const offsetInSegment = newVaddr - rwVirtualAddress;
  const newFileOffset = rwFileOffset + offsetInSegment;
  const oldRwFileEnd = rwFileOffset + rwFileSize;
  const extensionSize = newFileOffset + alignedNewSize - oldRwFileEnd;
  return { newVaddr, newFileOffset, alignedNewSize, extensionSize, compact };
}
function repackELFSection(elfBinary, binPath, newBunBuffer, outputPath, sectionHeaderSize) {
  try {
    const bunSection = elfBinary.getSection(".bun");
    if (!bunSection) {
      throw new Error(".bun section not found");
    }
    const rwSegment = elfBinary.segments().find((s) => s.type === "LOAD" && (s.flags & 2) !== 0);
    if (!rwSegment) {
      throw new Error("No writable ELF PT_LOAD segment found");
    }
    const newSectionData = buildSectionData(newBunBuffer, sectionHeaderSize);
    const oldBunSectionVaddr = bunSection.virtualAddress;
    const vaddrBytes = Buffer.alloc(8);
    vaddrBytes.writeBigUInt64LE(oldBunSectionVaddr);
    let bunCompiledVaddr = null;
    const rwContent = rwSegment.content;
    const rwVaddrStart = rwSegment.virtualAddress;
    const firstAligned = alignBigInt(
      rwVaddrStart,
      BigInt(BLOB_HEADER_ALIGNMENT)
    );
    const lastCandidate = rwVaddrStart + BigInt(rwContent.length) - 8n;
    for (let va = firstAligned; va <= lastCandidate; va += BigInt(BLOB_HEADER_ALIGNMENT)) {
      const off = Number(va - rwVaddrStart);
      if (rwContent.subarray(off, off + 8).equals(vaddrBytes)) {
        bunCompiledVaddr = va;
        break;
      }
    }
    if (bunCompiledVaddr === null) {
      throw new Error(
        `Could not find original BUN_COMPILED location in binary (searched for 0x${oldBunSectionVaddr.toString(16)})`
      );
    }
    const pageSize = elfBinary.pageSize();
    const newContentSize = BigInt(newSectionData.length);
    const loadSegments = elfBinary.segments().filter((s) => s.type === "LOAD");
    const topmostLoadEnd = loadSegments.reduce((max, s) => {
      const end = BigInt(s.virtualAddress) + BigInt(s.virtualSize);
      return end > max ? end : max;
    }, 0n);
    const placement = computeBunSectionPlacement({
      rwVirtualAddress: BigInt(rwSegment.virtualAddress),
      rwVirtualSize: BigInt(rwSegment.virtualSize),
      rwFileOffset: BigInt(rwSegment.fileOffset),
      rwFileSize: BigInt(rwSegment.fileSize),
      topmostLoadEnd,
      nextVirtualAddress: BigInt(elfBinary.nextVirtualAddress()),
      newContentSize,
      pageSize: BigInt(pageSize)
    });
    const { newVaddr, newFileOffset, extensionSize, compact } = placement;
    debug(
      `repackELFSection: ${compact ? "compact" : "fallback"} placement (topmost LOAD ends at 0x${topmostLoadEnd.toString(16)})`
    );
    if (extensionSize < 0n) {
      throw new Error(
        "New .bun location overlaps existing writable ELF segment"
      );
    }
    debug(
      `repackELFSection: moving .bun to offset=0x${newFileOffset.toString(16)}, vaddr=0x${newVaddr.toString(16)}, size=0x${newContentSize.toString(16)}`
    );
    if (extensionSize > 0n) {
      const extendedSegment = elfBinary.extend(rwSegment, extensionSize);
      if (!extendedSegment) {
        throw new Error("Failed to extend writable ELF PT_LOAD segment");
      }
    }
    bunSection.fileOffset = newFileOffset;
    bunSection.virtualAddress = newVaddr;
    bunSection.content = newSectionData;
    bunSection.size = newContentSize;
    const vaddrPatch = Buffer.alloc(8);
    vaddrPatch.writeBigUInt64LE(newVaddr);
    elfBinary.patchAddress(bunCompiledVaddr, vaddrPatch);
    debug(
      `repackELFSection: Patched BUN_COMPILED at vaddr 0x${bunCompiledVaddr.toString(16)} -> 0x${newVaddr.toString(16)}`
    );
    atomicWriteBinary(elfBinary, outputPath, binPath);
    debug("repackELFSection: Write completed successfully");
  } catch (error) {
    console.error("repackELFSection failed:", error);
    throw error;
  }
}
function repackELFOverlay(elfBinary, binPath, newBunBuffer, outputPath) {
  try {
    const newOverlay = Buffer.allocUnsafe(newBunBuffer.length + 8);
    newBunBuffer.copy(newOverlay, 0);
    newOverlay.writeBigUInt64LE(
      BigInt(newBunBuffer.length),
      newBunBuffer.length
    );
    debug(
      `repackELFOverlay: Setting overlay data (${newOverlay.length} bytes)`
    );
    elfBinary.overlay = newOverlay;
    debug(`repackELFOverlay: Writing modified binary to ${outputPath}...`);
    atomicWriteBinary(elfBinary, outputPath, binPath);
    debug("repackELFOverlay: Write completed successfully");
  } catch (error) {
    console.error("repackELFOverlay failed:", error);
    throw error;
  }
}
function repackNativeInstallation(binPath, modifiedClaudeJs, outputPath, clearBytecode) {
  LIEF.logging.disable();
  const binary = LIEF.parse(binPath);
  const bundle = locateBundle(binary, binPath);
  const parts = splitModulePayload(modifiedClaudeJs.toString("utf8"));
  const replacement = parts ? buildModuleReplacements(
    parts,
    collectClaudeJavaScriptModules(bundle.bunData, bundle.bunOffsets, bundle.moduleStructSize).map(([name]) => name)
  ) : modifiedClaudeJs;
  const newBuffer = rebuildBunData(
    bundle.bunData,
    bundle.bunOffsets,
    replacement,
    bundle.moduleStructSize,
    clearBytecode
  );
  bundle.write(newBuffer, outputPath);
}
export {
  CLAUDE_MODULE_BOUNDARY,
  buildModuleReplacements,
  bytecodeForReplacement,
  computeBunSectionPlacement,
  extractClaudeJsFromNativeInstallation,
  isChunkModule,
  isClaudeModule,
  repackNativeInstallation,
  resolveNixBinaryWrapper,
  sourceForInvalidatedBytecode,
  splitModulePayload
};
//# sourceMappingURL=claude-bundle-native-JMLDQG2L.js.map