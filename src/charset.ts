/* Decodifica dei byte ASCII restituiti dalla trasformazione degli spool (Host Print Transform). */

// CP850 (IBM PC multilingue): 0x80..0xFF
const CP850_HIGH =
  'ÇüéâäàåçêëèïîìÄÅ' +
  'ÉæÆôöòûùÿÖÜø£Ø×ƒ' +
  'áíóúñÑªº¿®¬½¼¡«»' +
  '░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐' +
  '└┴┬├─┼ãÃ╚╔╩╦╠═╬¤' +
  'ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀' +
  'ÓßÔÒõÕµþÞÚÛÙýÝ¯´' +
  '­±‗¾¶§÷¸°¨·¹³²■ ';

export function decodeCp850(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : CP850_HIGH[b - 0x80];
  return out;
}

/** Decodifica con il charset richiesto: cp850 (default degli spool), oppure un'etichetta WHATWG (latin1, utf-8, ...). */
export function decodeBytes(bytes: Uint8Array, charset: string): string {
  const cs = charset.trim().toLowerCase().replace(/[_\s]/g, '-');
  if (cs === 'cp850' || cs === 'ibm850' || cs === 'ibm-850' || cs === '850') return decodeCp850(bytes);
  try {
    return new TextDecoder(cs === 'latin1' ? 'windows-1252' : cs).decode(bytes);
  } catch {
    throw new Error(`Charset spool non supportato: '${charset}' (usa cp850, latin1, windows-1252, utf-8)`);
  }
}

/**
 * Normalizza il testo di uno spool trasformato: toglie il NUL iniziale, unifica i fine riga
 * (\r\n, \r\r\n → \n) ed elimina i CR isolati (sovrastampa).
 */
export function normalizeSpoolText(raw: string): string {
  return raw.replace(/\u0000/g, '').replace(/\r+\n/g, '\n').replace(/\r+\f/g, '\f').replace(/\r/g, '');
}

/** Divide il testo in pagine (form feed); l'ultima pagina vuota dopo un \f finale è scartata. */
export function splitPages(text: string): string[] {
  const pages = text.split('\f');
  if (pages.length > 1 && pages[pages.length - 1].trim() === '') pages.pop();
  return pages;
}
