import os, re, json, sys

# Read Plialu articles from database.js
with open('lib/database.js', 'r', encoding='utf-8') as f:
    src = f.read()

# Extract { id: ..., famille: "...", article: "..." }
articles = []
for m in re.finditer(r'\{\s*id:\s*(\d+)\s*,\s*famille:\s*"([^"]+)"\s*,\s*article:\s*"([^"]+)"\s*\}', src):
    articles.append({'id': int(m.group(1)), 'famille': m.group(2), 'article': m.group(3)})

print(f"Articles parsed: {len(articles)}", file=sys.stderr)

# List images
img_dir = 'assets/pieces'
imgs = [f for f in os.listdir(img_dir) if f.lower().endswith('.png')]
print(f"Images found: {len(imgs)}", file=sys.stderr)

def norm(s):
    s = s.lower().strip()
    s = re.sub(r'^capture\s+', '', s)  # drop leading "Capture "
    s = re.sub(r'\.png$', '', s)
    s = re.sub(r'[\s_\-+]+', ' ', s)
    s = s.replace('é', 'e').replace('è', 'e').replace('ê', 'e').replace('à', 'a').replace('ù', 'u').replace('ô', 'o').replace('î', 'i').replace('ç', 'c')
    s = re.sub(r'\s+', ' ', s).strip()
    return s

img_index = {}
for img in imgs:
    img_index[norm(img)] = img

# Try to match each article to an image
matches = {}
unmatched = []
for art in articles:
    key = norm(art['article'])
    if key in img_index:
        matches[art['article']] = img_index[key]
    else:
        # Loose match: any image whose normalized name contains the article's normalized form (or vice-versa)
        candidates = [(n, fname) for n, fname in img_index.items()
                      if key in n or n in key]
        if candidates:
            # pick the shortest (closest length)
            candidates.sort(key=lambda x: abs(len(x[0]) - len(key)))
            matches[art['article']] = candidates[0][1]
        else:
            unmatched.append(art['article'])

# Also build per-famille fallback (use first matched article in famille)
fam_imgs = {}
for art in articles:
    fam = art['famille']
    if fam in fam_imgs:
        continue
    if art['article'] in matches:
        fam_imgs[fam] = matches[art['article']]

# Famille-only image (e.g., "Bavette Accessoire.PNG")
for img in imgs:
    stem = re.sub(r'\.png$', '', img, flags=re.I)
    if stem in [a['famille'] for a in articles]:
        fam_imgs.setdefault(stem, img)

print(f"Matched: {len(matches)} / {len(articles)}", file=sys.stderr)
print(f"Famille images: {len(fam_imgs)}", file=sys.stderr)
print(f"Unmatched (sample): {unmatched[:8]}", file=sys.stderr)

# Output JS
out = {
    'articles': matches,
    'familles': fam_imgs,
}
with open('lib/piece-images.js', 'w', encoding='utf-8') as f:
    f.write('// Auto-generated mapping article/famille → image file in assets/pieces/\n')
    f.write('// Regenerate via: python3 scripts/build-image-manifest.py\n')
    f.write('window.PIECE_IMAGES = ')
    json.dump(out, f, ensure_ascii=False, indent=2)
    f.write(';\n')
print("Wrote lib/piece-images.js", file=sys.stderr)
