/**
 * Quick status (ENQ → STX STS1 STS2 ETX LRC), manual v8.3. STS1 = what the printer is doing,
 * STS2 = error. The extra STS2 codes (0x50…0x5C) come from the Python reference library.
 */

const STS1 = {
  0x40: { mode: 'training', state: 'idle' },
  0x41: { mode: 'training', state: 'fiscal_document_open' },
  0x42: { mode: 'training', state: 'non_fiscal_document_open' },
  0x60: { mode: 'fiscal', state: 'idle' },
  0x61: { mode: 'fiscal', state: 'fiscal_document_open' },
  0x62: { mode: 'fiscal', state: 'non_fiscal_document_open' },
  0x68: { mode: 'fiscal', state: 'idle', memoryFull: true },
  0x69: { mode: 'fiscal', state: 'fiscal_document_open', memoryFull: true },
  0x6a: { mode: 'fiscal', state: 'non_fiscal_document_open', memoryFull: true },
};

const STS2 = {
  0x40: { code: 'ok', message: 'Sin error' },
  0x41: { code: 'paper_out', message: 'Sin papel' },
  0x42: { code: 'mechanical', message: 'Error mecánico o de papel' },
  0x43: { code: 'mechanical_paper_out', message: 'Error mecánico y fin de papel' },
  0x48: { code: 'drawer', message: 'Error de gaveta' },
  0x50: { code: 'invalid_command_value', message: 'Comando o valor inválido' },
  0x54: { code: 'invalid_tax', message: 'Tasa inválida' },
  0x58: { code: 'no_directives', message: 'Sin directivas asignadas' },
  0x5c: { code: 'invalid_command', message: 'Comando inválido' },
  0x60: { code: 'fiscal_error', message: 'Error fiscal' },
  0x64: { code: 'fiscal_memory_error', message: 'Error de memoria fiscal' },
  0x6c: { code: 'fiscal_memory_full', message: 'Memoria fiscal llena' },
};

/**
 * @param {number} sts1
 * @param {number} sts2
 * @returns {{ sts1: number, sts2: number, mode: string, state: string, memoryFull: boolean,
 *             error: { code: string, message: string }, ready: boolean }}
 *   `ready` = idle and without error: the next document can be sent (the manual asks to wait for it).
 */
function decodeStatus(sts1, sts2) {
  const s1 = STS1[sts1] || { mode: 'unknown', state: 'unknown' };
  const s2 = STS2[sts2] || { code: 'unknown', message: `Error desconocido (0x${sts2.toString(16)})` };
  return {
    sts1,
    sts2,
    mode: s1.mode,
    state: s1.state,
    memoryFull: !!s1.memoryFull,
    error: s2,
    ready: s1.state === 'idle' && s2.code === 'ok',
  };
}

module.exports = { decodeStatus, STS1, STS2 };
