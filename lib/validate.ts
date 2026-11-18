// Strict input parsing: unknown fields and wrong types are refused, never ignored. No Next.js imports.

export class BadRequestError extends Error {
  status = 400;
}

/** A path id like "12". Anything else is a 400, never a guess. */
export function idParam(s: unknown): number {
  if (typeof s !== "string" || !/^[1-9]\d{0,9}$/.test(s)) throw new BadRequestError("Invalid id");
  return Number(s);
}

export function rejectQuery(req: Request) {
  if (new URL(req.url).search) throw new BadRequestError("Unexpected query string");
}

type FormSpec = Record<string, { re: RegExp; optional?: boolean }>;

/** Read a form body, allowing ONLY the listed fields, each matching its pattern. Plain strings only (no files). */
export async function readForm(req: Request, spec: FormSpec): Promise<Record<string, string | undefined>> {
  let form: FormData;
  if (!req.headers.get("content-type")) form = new FormData(); // a bodyless POST
  else {
    try {
      form = await req.formData();
    } catch {
      throw new BadRequestError("Unreadable form");
    }
  }
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of form.entries()) {
    if (!(k in spec)) throw new BadRequestError(`Unexpected field: ${k.slice(0, 30)}`);
    if (typeof v !== "string") throw new BadRequestError(`Field ${k} must be text`);
    if (k in out) throw new BadRequestError(`Field ${k} given twice`);
    out[k] = v;
  }
  for (const [k, s] of Object.entries(spec)) {
    const v = out[k];
    if (v === undefined) {
      if (!s.optional) throw new BadRequestError(`Missing field: ${k}`);
    } else if (!s.re.test(v)) throw new BadRequestError(`Invalid field: ${k}`);
  }
  return out;
}

/** Read a JSON body (bounded size). */
export async function readJson(req: Request): Promise<unknown> {
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) throw new BadRequestError("JSON expected");
  const text = await req.text();
  if (text.length > 50_000) throw new BadRequestError("Body too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequestError("Invalid JSON");
  }
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Throws if the object has any key outside the allowed list. */
export function onlyKeys(o: Record<string, unknown>, allowed: string[], where: string) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new BadRequestError(`Unexpected field in ${where}: ${k.slice(0, 30)}`);
}
