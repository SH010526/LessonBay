import os

# Files to fix encoding
html_files = [f for f in os.listdir('.') if f.endswith('.html')]
js_files = []
for root, dirs, files in os.walk('pages'):
    for f in files:
        if f.endswith('.js'):
            js_files.append(os.path.join(root, f))
css_files = ['style.css']

all_target_files = html_files + js_files + css_files + ['script.js']

print(f"Targeting {len(all_target_files)} files for encoding fix...")

for filepath in all_target_files:
    if not os.path.exists(filepath):
        continue
    
    try:
        # Detect encoding by attempting to read with different encodings
        content = None
        # Order of attempts: UTF-16-BE (from previous error), UTF-16-LE, UTF-16, then fallback
        encodings_to_try = ['utf-16-be', 'utf-16-le', 'utf-16', 'utf-8-sig', 'utf-8', 'cp949', 'euc-kr']
        
        with open(filepath, 'rb') as f:
            raw_data = f.read()
            
        for enc in encodings_to_try:
            try:
                content = raw_data.decode(enc)
                print(f"  [OK] Decoded {filepath} as {enc}")
                break
            except (UnicodeDecodeError, LookupError):
                continue
        
        if content is not None:
            # Standardize and save as UTF-8 (No BOM)
            # 1. If it's HTML, ensure <meta charset="UTF-8"> is present and at the top
            if filepath.endswith('.html'):
                import re
                # Ensure it has <!DOCTYPE html>
                if not content.strip().lower().startswith('<!doctype'):
                    content = "<!DOCTYPE html>\n" + content
                
                # Check for charset
                if '<meta charset="UTF-8">' not in content and '<meta charset="utf-8">' not in content.lower():
                    # Insert it after <head>
                    content = re.sub(r'(<head.*?>)', r'\1\n  <meta charset="UTF-8">', content, flags=re.IGNORECASE)
            
            with open(filepath, 'w', encoding='utf-8', newline='\n') as f:
                f.write(content)
            print(f"  [SUCCESS] Fixed {filepath}")
        else:
            print(f"  [ERROR] Could not decode {filepath}")
            
    except Exception as e:
        print(f"  [FATAL] Error processing {filepath}: {e}")

# Layout fixes in style.css
if os.path.exists('style.css'):
    with open('style.css', 'r', encoding='utf-8') as f:
        css = f.read()
    
    # Add forced image reset if not strong enough
    layout_patch = """
/* Emergency Layout Patch */
img {
  max-width: 100% !important;
  height: auto !important;
  display: block;
}
.detail-img, .thumb, .class-card img {
  max-width: 100% !important;
  height: auto !important;
}
.container {
  overflow-x: hidden !important;
}
"""
    if "/* Emergency Layout Patch */" not in css:
        with open('style.css', 'a', encoding='utf-8') as f:
            f.write(layout_patch)
        print("  [PATCHED] Added emergency layout fixes to style.css")
