/**
 * Character references for canonical text (src/comments/anchor.ts).
 *
 * HTMLRewriter hands text chunks over as raw source, so `&amp;` arrives as five
 * characters while the reader's DOM holds one. The page script (a later change) quotes DOM text,
 * so the server has to decode the same way a browser does or a passage with an
 * ampersand in it could never be found. The scope is the numeric forms and the
 * HTML 4 named set (the 252 names every Obsidian render can contain) plus
 * `&apos;`; the rest of HTML 5's two thousand names are not worth a table.
 */

/** Latin-1 names for U+00A0..U+00FF, in code point order. */
const LATIN1 =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(
    " ",
  );

/** The rest of HTML 4: special characters, Greek, arrows and mathematical symbols. */
const OTHERS =
  "quot 34 amp 38 lt 60 gt 62 apos 39 OElig 338 oelig 339 Scaron 352 scaron 353 Yuml 376 fnof 402 circ 710 tilde 732 " +
  "Alpha 913 Beta 914 Gamma 915 Delta 916 Epsilon 917 Zeta 918 Eta 919 Theta 920 Iota 921 Kappa 922 Lambda 923 Mu 924 Nu 925 Xi 926 Omicron 927 Pi 928 Rho 929 Sigma 931 Tau 932 Upsilon 933 Phi 934 Chi 935 Psi 936 Omega 937 " +
  "alpha 945 beta 946 gamma 947 delta 948 epsilon 949 zeta 950 eta 951 theta 952 iota 953 kappa 954 lambda 955 mu 956 nu 957 xi 958 omicron 959 pi 960 rho 961 sigmaf 962 sigma 963 tau 964 upsilon 965 phi 966 chi 967 psi 968 omega 969 thetasym 977 upsih 978 piv 982 " +
  "ensp 8194 emsp 8195 thinsp 8201 zwnj 8204 zwj 8205 lrm 8206 rlm 8207 ndash 8211 mdash 8212 lsquo 8216 rsquo 8217 sbquo 8218 ldquo 8220 rdquo 8221 bdquo 8222 dagger 8224 Dagger 8225 bull 8226 hellip 8230 permil 8240 prime 8242 Prime 8243 lsaquo 8249 rsaquo 8250 oline 8254 frasl 8260 euro 8364 image 8465 weierp 8472 real 8476 trade 8482 alefsym 8501 " +
  "larr 8592 uarr 8593 rarr 8594 darr 8595 harr 8596 crarr 8629 lArr 8656 uArr 8657 rArr 8658 dArr 8659 hArr 8660 " +
  "forall 8704 part 8706 exist 8707 empty 8709 nabla 8711 isin 8712 notin 8713 ni 8715 prod 8719 sum 8721 minus 8722 lowast 8727 radic 8730 prop 8733 infin 8734 ang 8736 and 8743 or 8744 cap 8745 cup 8746 int 8747 there4 8756 sim 8764 cong 8773 asymp 8776 ne 8800 equiv 8801 le 8804 ge 8805 sub 8834 sup 8835 nsub 8836 sube 8838 supe 8839 oplus 8853 otimes 8855 perp 8869 sdot 8901 lceil 8968 rceil 8969 lfloor 8970 rfloor 8971 " +
  // HTML 5 moved these two from U+2329/U+232A to the angle brackets; a browser
  // follows HTML 5, and the browser is what the page script quotes from.
  "lang 10216 rang 10217 loz 9674 spades 9824 clubs 9827 hearts 9829 diams 9830";

const NAMED = new Map<string, string>();
LATIN1.forEach((name, i) => NAMED.set(name, String.fromCharCode(160 + i)));
{
  const parts = OTHERS.split(" ");
  for (let i = 0; i < parts.length; i += 2) {
    NAMED.set(parts[i] as string, String.fromCodePoint(Number(parts[i + 1])));
  }
}

/**
 * Names a browser decodes even without the closing semicolon: Latin-1 plus the
 * four markup characters. Longest first, so `&notit` is `¬it` and not a miss.
 */
const LEGACY = [...LATIN1, "quot", "amp", "lt", "gt"].sort((a, b) => b.length - a.length);

/** Numeric references 0x80..0x9F mean windows-1252, not the C1 controls. */
const WINDOWS_1252: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020,
  0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152,
  0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022,
  0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

function numeric(code: number): string {
  if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
    return "�";
  }
  return String.fromCodePoint(WINDOWS_1252[code] ?? code);
}

const REFERENCE = /&(?:#([0-9]+);?|#[xX]([0-9a-fA-F]+);?|([A-Za-z][A-Za-z0-9]*);?)/g;

/**
 * Decode the character references in one run of source text, and normalise
 * line endings the way an HTML parser does (CRLF and bare CR become LF) so the
 * run has the characters a DOM text node would.
 */
export function decodeEntities(source: string): string {
  const text = source.includes("\r") ? source.replace(/\r\n?/g, "\n") : source;
  if (!text.includes("&")) return text;
  return text.replace(REFERENCE, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (dec !== undefined) return numeric(parseInt(dec, 10));
    if (hex !== undefined) return numeric(parseInt(hex, 16));
    const word = name as string;
    if (whole.endsWith(";")) {
      const hit = NAMED.get(word);
      if (hit !== undefined) return hit;
    }
    // No semicolon (or an unknown name with one): only the legacy names decode,
    // and only as a prefix, the rest of the word staying literal text.
    for (const legacy of LEGACY) {
      if (word.startsWith(legacy)) {
        return (NAMED.get(legacy) as string) + whole.slice(1 + legacy.length);
      }
    }
    return whole;
  });
}

/** Count of named references, for the test that pins the table's size. */
export const NAMED_ENTITY_COUNT = NAMED.size;
