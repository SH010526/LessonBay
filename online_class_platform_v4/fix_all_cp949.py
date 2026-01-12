import os

dir_path = r'c:\Users\soong\LessonBay\online_class_platform_v4'

count = 0
for fname in os.listdir(dir_path):
    if fname.lower().endswith('.html'):
        fpath = os.path.join(dir_path, fname)
        try:
            # Read as CP949
            with open(fpath, 'r', encoding='cp949') as f:
                content = f.read()
            
            # Write back as UTF-8
            with open(fpath, 'w', encoding='utf-8') as f:
                f.write(content)
            print(f"Fixed: {fname}")
            count += 1
        except Exception as e:
            print(f"Failed {fname}: {e}")

print(f"Total fixed: {count}")
