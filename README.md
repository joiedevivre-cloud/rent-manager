# 🏠 임대 관리 앱

가족 3명이 함께 쓰는 다가구 주택 임대 관리 웹앱입니다.

---

## 배포 전 설정 순서

### 1단계. Supabase 프로젝트 생성

1. [supabase.com](https://supabase.com) 접속 → **Start your project** 클릭
2. GitHub 계정으로 가입/로그인
3. **New Project** 클릭
4. 이름: `rent-manager`, 비밀번호 설정(메모해두기), 지역: **Northeast Asia (Seoul)**
5. 프로젝트 생성 완료까지 1~2분 대기

> 생성 후 **Project Settings > API** 에서 `Project URL`과 `anon public` 키를 메모해두세요.

---

### 2단계. 데이터베이스 스키마 적용

1. Supabase 대시보드 왼쪽 메뉴 → **SQL Editor**
2. `supabase/migrations/001_init_schema.sql` 파일 내용을 전체 복사해서 붙여넣기 → **Run** 클릭
3. `supabase/migrations/002_seed_data.sql` 파일을 열어서 **가족 3명 이메일**을 실제 이메일로 교체 후 실행
   ```sql
   insert into allowed_emails (email, name) values
     ('어머니이메일@gmail.com', '어머니이름'),
     ('오빠이메일@gmail.com', '오빠이름'),
     ('나이메일@gmail.com', '내이름');
   ```
4. 나머지 시드 데이터도 함께 실행

---

### 3단계. Google OAuth 설정

#### Google Cloud Console에서 OAuth 클라이언트 만들기

1. [console.cloud.google.com](https://console.cloud.google.com) 접속
2. 새 프로젝트 생성 (이름: `rent-manager`)
3. 왼쪽 메뉴 → **API 및 서비스 > OAuth 동의 화면**
   - 사용자 유형: **외부** → 만들기
   - 앱 이름, 이메일 입력 → 저장 후 계속
4. **사용자 인증 정보 > 사용자 인증 정보 만들기 > OAuth 2.0 클라이언트 ID**
   - 애플리케이션 유형: **웹 애플리케이션**
   - 승인된 리디렉션 URI에 추가:
     ```
     https://[YOUR_SUPABASE_PROJECT_ID].supabase.co/auth/v1/callback
     ```
     (Supabase Project Settings > API에서 URL 확인 가능)
5. **클라이언트 ID**와 **클라이언트 보안 비밀번호** 메모

#### Supabase에 Google 연결

1. Supabase 대시보드 → **Authentication > Providers**
2. **Google** 클릭 → Enable 토글 켜기
3. Google Client ID, Client Secret 입력 → Save

---

### 4단계. Storage 버킷 생성

1. Supabase 대시보드 → **Storage**
2. **New bucket** 클릭
   - Name: `tenant-documents`
   - Public: **끄기** (비공개)
3. 버킷 생성 후 **Policies** 탭 클릭
4. **New policy** → For full customization → 아래 정책 4개 추가:

   | 정책 | Operation | USING expression |
   |------|-----------|-----------------|
   | 업로드 허용 | INSERT | `(select is_allowed_user())` |
   | 다운로드 허용 | SELECT | `(select is_allowed_user())` |
   | 수정 허용 | UPDATE | `(select is_allowed_user())` |
   | 삭제 허용 | DELETE | `(select is_allowed_user())` |

---

### 5단계. GitHub 레포 생성

1. [github.com](https://github.com) → **New repository**
2. 이름: `rent-manager`, Private 선택 → Create
3. 터미널에서:
   ```bash
   cd rent-manager
   git init
   git add .
   git commit -m "initial commit"
   git remote add origin https://github.com/[YOUR_USERNAME]/rent-manager.git
   git push -u origin main
   ```

---

### 6단계. Vercel 배포

1. [vercel.com](https://vercel.com) 접속 → GitHub로 로그인
2. **New Project** → GitHub 레포 `rent-manager` 선택
3. **Environment Variables** 섹션에서 추가:
   | Key | Value |
   |-----|-------|
   | `VITE_SUPABASE_URL` | `https://[project-id].supabase.co` |
   | `VITE_SUPABASE_ANON_KEY` | `eyJ...` (anon public key) |
   | `VITE_KAKAO_JS_KEY` | 카카오 JavaScript 키 (아래 8단계 참고) |
4. **Deploy** 클릭

---

### 7단계. Vercel URL을 Google OAuth 리디렉션에 추가

배포 완료 후 Vercel URL이 생성되면:

1. Google Cloud Console → OAuth 2.0 클라이언트 ID → 편집
2. **승인된 JavaScript 원본** 추가: `https://rent-manager-xxx.vercel.app`
3. Supabase → **Authentication > URL Configuration**
   - Site URL: `https://rent-manager-xxx.vercel.app`
   - Redirect URLs에 `https://rent-manager-xxx.vercel.app` 추가

---

### 8단계. 카카오톡 공유 기능 설정

세입자 상세 화면에서 카카오톡으로 청구 메시지를 공유하려면 아래 설정이 필요합니다.

#### JavaScript 키 확인
1. [developers.kakao.com](https://developers.kakao.com) 접속 → 로그인
2. **내 애플리케이션** → 로그인용으로 만든 앱 클릭
3. **앱 키** 탭 → **JavaScript 키** 복사 (REST API 키와 다른 키입니다)

#### 도메인 등록
1. 같은 앱 페이지에서 **플랫폼** 탭 클릭
2. **Web 플랫폼 등록** 또는 기존 Web 항목 편집
3. **사이트 도메인**에 아래 두 주소 추가:
   ```
   http://localhost:5173
   https://[배포된-vercel-주소].vercel.app
   ```
4. 저장

#### 환경변수 설정
`.env.local` 파일에 추가:
```
VITE_KAKAO_JS_KEY=복사한_JavaScript_키
```
Vercel 배포 시에도 환경변수에 동일하게 추가.

> **참고**: 카카오톡 공유는 "받는 사람 자동 지정"이 불가능합니다. 버튼을 누르면 카카오톡의 "보낼 사람 선택" 화면이 열리고, 사용자가 직접 받는 사람을 선택하는 방식입니다. 메시지 내용(청구액 등)은 자동으로 채워집니다.

---

## 로컬 개발

```bash
# 의존성 설치
npm install

# 환경변수 설정 (.env.local 파일 생성)
VITE_SUPABASE_URL=https://[project-id].supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...

# 개발 서버 시작
npm run dev
```
