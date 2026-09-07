import fs from 'node:fs';
import LIEF from 'node-lief';

const NIX_WRAPPER_MAX_SIZE = 200_000;

export function resolveNixBinaryWrapper(binaryPath: string): string | null {
  try {
    const stat = fs.statSync(binaryPath);
    if (stat.size > NIX_WRAPPER_MAX_SIZE) return null;

    LIEF.logging.disable();
    const binary = LIEF.parse(binaryPath);
    const hasExecv = binary.symbols().some(sym => {
      const name = sym.name;
      return name === 'execv' || name === '_execv';
    });
    if (!hasExecv) return null;

    let rawBytes: Buffer | null = null;
    if (binary.format === 'ELF') {
      const rodata = binary.sections().find(s => s.name === '.rodata');
      if (rodata) rawBytes = rodata.content;
    } else if (binary.format === 'MachO') {
      const machoBinary = binary as LIEF.MachO.Binary;
      const textSeg = machoBinary.getSegment('__TEXT');
      if (textSeg) {
        const cstring = textSeg.getSection('__cstring');
        if (cstring) rawBytes = cstring.content;
      }
    }
    if (!rawBytes || rawBytes.length === 0) return null;

    const text = rawBytes.toString('utf-8');
    const docstringMatch = text.match(/makeCWrapper\s+'(\/nix\/store\/[^']+)'/);
    if (docstringMatch) return docstringMatch[1];

    const unquotedMatch = text.match(/makeCWrapper\s+(\/nix\/store\/\S+)/);
    if (unquotedMatch) return unquotedMatch[1];

    const nixPaths = text.match(/\/nix\/store\/[^\s]+/g);
    return nixPaths?.find(candidate => candidate.includes('/bin/')) ?? null;
  } catch {
    return null;
  }
}
