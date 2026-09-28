// Lists the file names in each OFL family folder of the Google Fonts repository.
const api = "https://api.github.com/repos/google/fonts/contents/ofl/";
for (const d of ["manrope", "playfairdisplay", "oswald", "ptmono", "caveat", "notocoloremoji"]) {
  const r = await fetch(api + d);
  const j = (await r.json()) as { name: string; size: number }[];
  console.log("==", d);
  for (const f of j) console.log(f.name, f.size);
}
