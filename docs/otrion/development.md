# Otrion 개발 가이드

Otrion의 `main`은 Microsoft의 Code - OSS 릴리스 태그 `1.147.0`에서 분기했습니다. 루트의 `LICENSE.txt`와 `ThirdPartyNotices.txt`는 업스트림 고지이며, Otrion Context 확장의 라이선스는 MIT입니다.

## macOS에서 빌드하고 실행하기

Git, Xcode와 Command Line Tools, Python 3, nvm을 준비합니다. 네이티브 모듈 빌드에 사용할 Xcode는 `xcode-select -p`로 확인할 수 있습니다. 아래 명령은 저장소 루트에서 실행합니다. 네트워크 연결이 필요합니다.

```sh
nvm install
nvm use
npm install -g "$(node -p "require('./package.json').packageManager")"
PNPM_CONFIG_FROZEN_LOCKFILE=true pnpm install --frozen-lockfile
pnpm run build-fast
./scripts/code.sh .
```

Node 버전은 `.nvmrc`, pnpm 버전은 루트 `package.json`에 고정돼 있습니다. 현재 값은 각각 24.22.1과 12.16.0입니다. 이미 해당 버전의 pnpm을 사용할 수 있으면 전역 설치 단계는 생략합니다. 최초 실행 시 런처가 Electron과 추가 내장 확장을 내려받습니다.

개발 빌드는 `pnpm run build-fast`로 증분 갱신합니다. 타입 검사까지 포함한 전체 컴파일은 `pnpm run compile`을 사용합니다. 지속적으로 편집할 때는 한 터미널에서 `pnpm run watch`를 실행하고, 첫 빌드가 끝나면 다른 터미널에서 `nvm use`, `./scripts/code.sh .`를 실행합니다. Linux도 셸 런처를 사용하며 Windows의 진입점은 `scripts\code.bat`입니다. [플랫폼별 네이티브 빌드 도구](https://github.com/microsoft/vscode/wiki/How-to-Contribute#prerequisites)

## 첫 기능 확인

편집기에서 코드를 선택하고 명령 팔레트(⌘⇧P)를 열어 `Otrion: Copy Selection with File Path`를 실행합니다. 한국어 UI의 명령 이름은 `Otrion: 선택 영역을 파일 경로와 함께 복사`입니다. 새 문서에 붙여넣으면 파일 경로, 줄 범위, 코드가 보입니다. 여러 선택 영역도 함께 복사합니다.

## 코드를 추가할 위치

| 위치 | 역할 |
| --- | --- |
| `extensions/otrion-context/` | 실제 내장 확장 예제. 매니페스트가 명령을 선언하고 확장 호스트가 실행 시 `extension.js`를 로드합니다. |
| `extensions/otrion-*/` | 새 기능의 개발 위치. 예를 들어 모델 제공자 통합은 별도 확장에 두고, 채팅 UI는 VS Code의 Chat API를 사용할 수 있습니다. 패키지 의존성이 생기면 해당 확장을 루트 `pnpm-workspace.yaml`에 등록하고 잠금 파일을 갱신합니다. |
| `product.json` | 앱 이름, 데이터 디렉터리, URL 스킴, 운영체제별 앱 식별자 |
| `src/vs/workbench/contrib/` | 공개 확장 API로 구현하기 어려운 셸 UI를 추가하는 위치. 코어 변경은 기능별 커밋으로 관리하면 다음 업스트림 병합 시 검토하기 쉽습니다. |

샘플 확장은 런타임 패키지 의존성과 별도 컴파일 단계가 없습니다. 확장 코드를 편집한 뒤 개발 창에서 `Developer: Reload Window`를 실행해 다시 로드합니다.

## Git 원격과 업데이트

현재 로컬 저장소에는 공식 Microsoft 저장소가 `upstream`으로 등록돼 있습니다. 자신의 빈 원격 저장소를 만든 뒤 최초 공개할 때 아래 예시의 URL을 실제 주소로 교체합니다.

```sh
git remote add origin https://github.com/YOUR-ORG/otrion.git
git push -u origin main
```

다른 개발자가 Otrion을 clone한 경우에는 다음 명령으로 공식 원격을 한 번 등록합니다.

```sh
git remote add -t main upstream https://github.com/microsoft/vscode.git
```

업데이트할 때는 작업 내용을 커밋한 상태에서 시작합니다. 아래 명령의 태그는 현재 기준 버전이므로 적용할 새 릴리스 태그로 바꿉니다.

```sh
tag=1.147.0
git switch main
git fetch upstream tag "$tag"
git switch -c "sync/vscode-$tag"
git merge --no-ff "$tag"
```

충돌이 생기면 Otrion 제품 식별자와 업스트림 신규 설정을 함께 반영한 뒤 `git add`와 `git merge --continue`로 병합을 마칩니다. 위 빌드 절차를 새 태그의 Node·pnpm 버전으로 다시 실행하고, 앱 실행과 Otrion 명령을 확인합니다. README와 이 가이드의 기준 버전도 갱신한 뒤 동기화 브랜치를 `main`에 병합합니다. 릴리스 사이에 업스트림 개발 내용을 확인하려면 `git fetch upstream main`, `git log --oneline HEAD..upstream/main`을 사용합니다.
