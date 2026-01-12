import sys

try:
    with open('c:/Users/soong/LessonBay/online_class_platform_v4/logout.html', 'r', encoding='cp949') as f:
        content = f.read()
        print("Successfully read as CP949")
        if "로그아웃" in content:
            print("FOUND_KEYWORD: 로그아웃")
        else:
            print("Content peek:", content[:100])
except Exception as e:
    print("Error:", e)
