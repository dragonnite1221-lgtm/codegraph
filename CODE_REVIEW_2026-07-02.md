> 리뷰 일자: 2026-07-02 · 대상 브랜치: 0dcdfa9 시점 스냅샷 · 읽기 전용 정적 분석 (코드 미수정)

# CodeGraph 종합 코드리뷰 (v0.7.12)

## 리포 개요

로컬 우선 코드 인텔리전스 라이브러리 + CLI + MCP 서버. tree-sitter(WASM)로 파싱 → SQLite(FTS5, better-sqlite3/node-sqlite3-wasm 폴백)에 노드/엣지/파일 저장 → MCP로 9개 도구 노출. `src/` 265개 + `__tests__/` 120개 TS 파일, 4개 에이전트 타깃(Claude/Cursor/Codex/opencode) 설치기 내장. 최근 이력은 "200줄 게이트 번다운"(PR #32~#46)에 집중되어 있고 워킹트리는 클린 상태다.

## 종합 평가: **양호 (우수에 근접)**

아키텍처 규율(레이어드 파이프라인, 200줄 게이트 완전 소진, strict TS, 문서-코드 동기화 테스트)이 매우 뛰어나고, SQL은 전면 파라미터화되어 인젝션 표면이 사실상 없다. 다만 **설치기의 `~/.claude.json` 파스 실패 시 전체 클로버**, **FileLock 2분 스테일 타임아웃이 살아있는 장기 인덱싱 락을 탈취하는 문제**, **죽은 파일 워처가 active로 계속 보고되는 문제** 등 안정성 축의 High급 결함 3건이 등급을 한 단계 끌어내린다.

---

## 발견 사항

### High

**H1. JSON 파스 실패 시 `~/.claude.json` 전체 내용 소실 (설치기)**
- `src/installer/targets/shared.ts:51-66` + `src/installer/targets/claude-io.ts:59-62` (Cursor도 동일 패턴: `cursor-io.ts`)
- `readJsonFile`은 파스 실패 시 `{}`를 반환하고, `writeMcpEntry`는 그 객체에 codegraph 항목만 얹어 **파일 전체를 다시 쓴다**:
  ```ts
  } catch (err) { ... return {}; }        // shared.ts:64
  existing.mcpServers.codegraph = after;
  writeJsonFile(file, existing);          // claude-io.ts:61-62 — existing === {}
  ```
- `~/.claude.json`은 Claude Code의 전역 상태(모든 MCP 서버, 프로젝트 설정)를 담는 고가치 파일이다. 일시적 손상/트레일링 콤마 하나로 `{"mcpServers":{"codegraph":...}}`만 남는다. `.backup` 생성(shared.ts:62)이 완화책이지만, **백업 경로가 고정**이라 두 번째 실행 시 이미 클로버된 `{}`가 유일한 백업을 덮어써 원본이 영구 소실된다. 백업 실패도 `catch { /* ignore */ }`(shared.ts:63)로 무시하고 계속 진행한다.
- 권고: 파스 실패 시 쓰기를 **중단**하고 사용자에게 복구 안내(에러 exit). 백업은 타임스탬프 부여, 백업 실패 시 진행 금지. opencode 타깃이 이미 쓰는 jsonc-parser 서지컬 편집으로 통일하는 것도 방법.

**H2. FileLock 스테일 판정이 살아있는 프로세스의 락을 탈취**
- `src/concurrency.ts:22,41-49`
  ```ts
  private static readonly STALE_TIMEOUT_MS = 2 * 60 * 1000;
  if (lockAge < FileLock.STALE_TIMEOUT_MS && !isNaN(pid) && this.isProcessAlive(pid)) { throw ... }
  // Stale lock (dead process or timed out) - remove it
  fs.unlinkSync(this.lockPath);
  ```
- 락이 2분보다 오래되면 **PID가 살아 있어도** 삭제하고 탈취한다. 그런데 이 코드베이스 스스로 "indexing operations can hold locks for extended periods"라며 SQLite `busy_timeout`을 2분으로 잡았고(`src/db/index.ts:45-47`), WASM 백엔드는 5-10배 느리다고 배너에 명시한다. 대형 리포 인덱싱이 2분을 넘는 순간(흔함) MCP 자동 sync나 두 번째 CLI가 락을 훔쳐 **동시 기록자 2개**가 생긴다. `indexing-operations.ts`에는 락 mtime 갱신(하트비트)이 전혀 없다.
- 권고: 장기 작업 중 주기적 mtime touch(하트비트) 추가, 또는 스테일 판정을 "타임아웃 **그리고** PID 사망"의 AND 조건으로 변경.

**H3. fs.watch 에러 후 죽은 워처가 `isActive() === true`로 계속 보고**
- `src/sync/watcher.ts:116-119, 153-155`
  ```ts
  this.watcher.on('error', (err) => {
    logWarn('File watcher error', ...);
    // Don't crash — watcher may recover or user can restart
  });
  ...
  isActive(): boolean { return this.watcher !== null && !this.stopped; }
  ```
- inotify 한도 초과, 디렉터리 삭제/리마운트 등에서 `error`는 대개 종결적이다. 이후 이벤트는 영원히 오지 않지만 `this.watcher`가 남아 있어 MCP는 "File watcher active — graph will auto-sync"라 믿고, **그래프가 조용히 낡아간다** (이 도구의 지시문이 "grep으로 재검증하지 말고 codegraph를 믿어라"인 만큼 치명적 조합).
- 권고: error 시 watcher를 null 처리하고 재장착(re-arm) 시도 또는 dead 플래그로 status에 노출.

### Medium

**M1. 재시도 경로의 무방비 `fsp.stat`이 indexAll 전체를 중단시키고 워커를 누수**
- `src/extraction/bulk-retry.ts:87, 143` — 바로 위 `readFile`은 try/catch인데 `const stats = await fsp.stat(fullPath);`는 무방비. 읽기와 stat 사이에 파일이 지워지면(리베이스 중 실제 발생 가능) rejection이 `extraction-index-all.ts:125`(`await retryWasmMemoryFailures`)로 전파되어 `pool.dispose()`(138행)를 건너뛴다 — 인덱싱 실패 + 파스 워커 누수.

**M2. 그래머 로드 실패 시 워커 누수 + 오염된 워커 재사용**
- `src/extraction/parse-worker-pool.ts:95-106` — `this.parseWorker = worker`를 **그래머 로드 전에** 대입. `loadGrammarsInWorker`가 reject되면 워커는 살아 있고 참조도 남아, 다음 `ensureWorker()`가 그래머 없는 워커를 그대로 반환한다. 실패 시 terminate + null 처리 필요.

**M3. 해석(resolution) 캐시가 무한 성장 — 주석은 "(bounded)"라고 거짓 주장**
- `src/resolution/index.ts:44-45` (`// per-file node cache (bounded)`, `// per-file content cache (bounded)`) vs `src/resolution/resolution-context.ts:89-104` — `fileCache`는 읽은 **모든 파일의 전체 소스 문자열**을 Map에 저장하며 어디에도 eviction이 없다(grep으로 확인: MAX/evict/size 체크 부재). 대형 코드베이스의 resolve 단계에서 리포 소스 상당량이 힙에 상주한다. `db/node-cache.ts`의 LRU(max 1000)와 대조적.

**M4. MCP `projectPath` 인자가 무검증 — 문서화된 가드가 데드 코드**
- `src/path-security.ts:50` `validateProjectPath`는 docstring에 "Used at MCP and API entry points"라 쓰여 있으나 **호출처가 0곳**(정의 + utils 재수출뿐임을 grep으로 확인). 실제 MCP 경로인 `src/mcp/tool-project-cache.ts:54-90`은 임의 경로를 resolve해 상위로 `.codegraph`를 탐색해 열어준다. 민감 디렉터리 차단이 설계만 있고 배선이 빠졌다.

**M5. `findPath`의 경로 배열 전량 복사 — 대형 그래프에서 O(V·L) 메모리**
- `src/graph/traversal.ts:142-146` `path: [...path, { node: nextNode, edge }]` — 큐 항목마다 전체 경로 복사, `traverseBFS`에 있는 `limit` 캡도 없음. predecessor 맵으로 O(V) 재구성 권고.

**M6. 파일당 3~4개의 개별 트랜잭션 — 커밋 배칭 부재**
- `src/extraction/result-storage.ts:41-77` — `insertNodes`/`insertEdges`/`insertUnresolvedRefsBatch`가 각자 `db.transaction`(node-queries.ts:74-80 등)으로 커밋하고 `upsertFile`은 자동커밋. 파일 N개 인덱싱 = 커밋 3N+회. WAL+NORMAL에선 견딜 만하지만 WASM 폴백(DELETE 저널 + synchronous FULL, `sqlite-wasm-adapter.ts:112-125`)에선 커밋마다 fsync라 "5-10x 느림"을 더 악화시킨다. 파일 단위(또는 배치 단위) 단일 트랜잭션으로 묶을 것.

**M7. 레거시 `## CodeGraph` 헤딩 마이그레이션이 사용자 섹션을 오식별 가능**
- `src/installer/targets/claude-io.ts:100-113` — 마커 없는 파일에서 `\n## CodeGraph\n` 헤딩만으로 다음 `## `까지 통째로 템플릿 치환. 사용자가 직접 쓴 동명 섹션이면 본문이 소리 없이 사라진다.

### Low

**L1. MCP serverInfo 버전이 `0.1.0`으로 하드코딩** — `src/mcp/mcp-handlers.ts:14-17` (`version: '0.1.0'`) vs package.json `0.7.12`. `getVersion()`(installer-flow)이 이미 있으니 재사용 가능.

**L2. FTS 검색의 전면 오류 삼킴** — `src/db/search-internals-fts.ts:79-82` `catch { return []; }` — FTS 문법 오류만이 아니라 DB 손상/락 오류까지 "결과 없음"으로 위장된다. 오류 종류 구분 권고.

**L3. LIKE 와일드카드 이스케이프 불일치** — `src/db/file-queries.ts:24-26`은 `%`/`_`를 이스케이프하지만, `search-internals-fts.ts:115-117`과 `search-queries-find.ts:122`의 `%${query}%` / `%${substring}%`는 하지 않는다. 인젝션은 아니고(파라미터 바인딩) 검색어에 `%`가 들어가면 오탐하는 기능 결함.

**L4. CLI 숫자 옵션 NaN 무검증** — `src/bin/query-command.ts:34`, `context-command.ts:40-41`, `affected-command.ts:56`, `files-command.ts:83` — `parseInt(options.limit||'10')`에 `--limit abc` → `NaN`이 쿼리 계층까지 전파. MCP 쪽 `boundedNumber`(tool-args.ts) 같은 가드를 CLI에도.

**L5. `runSync`의 락 획득 실패가 정상 0건 결과로 위장** — `src/indexing-operations.ts:79-82` `catch { return { filesChecked: 0, ... }; }` — 호출자가 "변경 없음"과 "락 실패"를 구분 불가 (runIndexAll은 error를 담아 반환하는 것과 비대칭).

**L6. `readFileInChunks`의 UTF-8 멀티바이트 경계 손상** — `src/concurrency-mutex.ts:62-79` — 64KB 경계에 걸친 멀티바이트 문자가 깨진다. 현재 src 내 호출처 없음(공개 API로 export만 됨) — 죽었지만 노출된 헬퍼. `StringDecoder` 사용 또는 export 제거.

**L7. WASM 어댑터 `transaction`은 중첩 불가 (latent)** — `src/db/sqlite-wasm-adapter.ts:139-150` 단순 BEGIN/COMMIT. better-sqlite3는 savepoint로 중첩을 지원하므로 계약이 다르다. 현재 중첩 호출은 없음을 확인했으나 미래 결합 시 wasm 경로만 터진다. 최소한 주석/가드 필요.

**L8. 재시도용 주석 제거가 `//`만 처리** — `src/extraction/bulk-retry.ts:131` — Python `#`, 블록 주석 등에는 최후 폴백이 무의미.

**L9. `args.kind` 무검증 캐스트** — `src/mcp/tool-handlers.ts:33` `args.kind as NodeKind` — 잘못된 kind는 (파라미터 바인딩이라 안전하지만) 빈 결과로 조용히 귀결. `NODE_KINDS` 멤버십 검사 후 오류 메시지 반환이 낫다.

**L10. 리포 루트 잔재물** — `debug_python_ast.js`, `test_python_inheritance.js`(dist 의존 스크래치), `REFACTORING_PLAN.md`(2026-06-11자, "테스트 22개" — 현재 111개로 낡음), `run-interactive-test.md`. `docs/`로 이동 또는 삭제 권고.

**L11. TOML 직렬화기의 잠재 엣지** — `src/installer/targets/toml.ts:42-46` 이스케이프가 `\`/`"`뿐(제어문자 시 깨진 TOML), `toml.ts:127-133` 헤더 탐지가 컬럼 0 한정(들여쓴 기존 블록이면 중복 테이블 추가). 현재 페이로드가 고정 문자열이라 미도달이나 방어 없음.

---

## 확인했으나 문제없음 (긍정 사항)

- **SQL 인젝션 없음**: 동적 SQL 전수 grep 결과 전부 `?` 플레이스홀더 생성(`kinds.map(() => '?')`)이며 값은 바인딩. FTS 쿼리도 특수문자 제거 + `AND/OR/NOT/NEAR` 연산자 스트립 후 파라미터로 전달(`search-internals-fts.ts:27-35`, 이슈 #173 회귀 주석 포함).
- **명령 실행 안전**: git 호출은 전부 `execFileSync('git', [...])` 배열 인자 + timeout(`file-scanner.ts`), `shell:true` 전무. `installer/index.ts:88`의 execSync는 고정 문자열, `publish.js`의 bump는 switch로 화이트리스트.
- **경로 보안 심층 방어**: `path-security.ts`의 realpath 심링크 검사, `directory.ts:118-124`의 심링크 안전 삭제, `file-scanner-scan.ts`의 realpath 방문 집합으로 심링크 순환 차단, 추출 읽기 경로 전반에 `validatePathWithinRoot` 적용.
- **설치기 모범 사례**: 원자적 쓰기(tmp+rename, `shared.ts:74-87`), opencode의 jsonc-parser 서지컬 편집(주석/포맷 보존), TOML 형제 테이블 바이트 보존, `unchanged` 멱등성, preuninstall 훅은 이중 try/catch로 npm uninstall을 절대 막지 않고 `.codegraph/`는 건드리지 않음.
- **MCP 수명주기**: 핸드셰이크를 무거운 init **전에** 응답(이슈 #172, 30s 타임아웃 회피), `initPromise`로 이중 open 경합 방지, 출력 15,000자 절단, `boundedNumber` 클램프.
- **워커 크래시 복구 설계**: WASM OOM 시 워커가 스스로 exit(1) → pool이 pending reject → `bulk-retry`가 새 워커로 재시도. settle 가드로 promise 이중 정착 방지, 타이머 전부 정리.
- **WASM 폴백**: 프라그마 재매핑(WAL→DELETE, NORMAL→FULL, mmap 스킵), VACUUM 전 스테이트먼트 finalize, stderr 배너에 복구 레시피 고정(단일 소스).
- **200줄 게이트 완전 소진**: `node scripts/check-file-size.cjs` 실행 결과 "0 baseline violations" — `file-size-baseline.txt`에 실제 항목 0개. 게이트가 형식적이지 않고 실제로 번다운 완료됨.
- **문서-코드 동기화 강제**: `__tests__/instructions-sync.test.ts`가 `.mdc` 본문 == `INSTRUCTIONS_TEMPLATE`, 3개 문서의 도구 참조 == 등록 도구 집합을 검증.
- **타입 안전성**: tsconfig에 `strict` + `noUncheckedIndexedAccess` 등 전 플래그. `: any`는 15곳(대부분 sqlite 어댑터 경계), `as any` 1곳.
- **CI/릴리즈**: ci.yml이 Node 20/22 매트릭스에서 typecheck → 파일크기 게이트 → build → 전체 테스트. `release.sh`는 태그 로컬/origin/릴리즈 존재를 각각 검사하는 진짜 멱등 스크립트(`set -euo pipefail`).
- **테스트 체계**: 111개 테스트 파일(~14.4k줄), DB 목 없이 실제 SQLite + 임시 디렉터리, 설치기 파라미터라이즈드 계약 테스트, 회귀 앵커 테스트(pr19 등) 유지.

## 관점별 평가표

| 관점 | 점수 | 근거 |
|---|---|---|
| 보안성 | **8.5/10** | SQL 전면 파라미터화·FTS 연산자 스트립·심링크 방어·no-shell 실행. 감점: validateProjectPath 미배선(M4), LIKE 이스케이프 불일치(L3) |
| 안정성 | **7/10** | 워커 크래시 복구·락 TOCTOU 처리는 수준급이나, 락 탈취(H2)·죽은 워처(H3)·무방비 stat(M1)·워커 누수(M2)가 실사용 시나리오에서 발현 가능 |
| 효율성 | **7.5/10** | 프리페어드 스테이트먼트 lazy 캐시·워커 재활용·배치 해석은 좋음. 감점: 무한 해석 캐시(M3), findPath O(V·L)(M5), 파일당 다중 커밋(M6) |
| 보수 용이성 | **9/10** | 200줄 게이트 베이스라인 0건, strict TS, instructions-sync 테스트, 분할 시 재수출 규율. 감점: "(bounded)" 거짓 주석, 버전 0.1.0 드리프트, 루트 잔재물 |
| 확장성 | **9/10** | 새 에이전트=파일 1개+레지스트리 1줄, 언어별 extractor 1파일, 프레임워크 리졸버 플러그인 구조가 실제로 지켜짐 (Codex/opencode 타깃이 그 증거) |
| 체계성 | **8.5/10** | CI 4단계 완비, 멱등 릴리즈, 111개 테스트·실 DB 테스트. 감점: bin/CLI 계층·search 스코어링·Svelte/Liquid extractor·프레임워크 개별 테스트 공백, 커버리지 임계치 미설정 |

## 개선 우선순위 Top 5

1. **H1 — 설치기 파스 실패 시 쓰기 중단 + 타임스탬프 백업**: `~/.claude.json` 클로버는 사용자 데이터 손실이며 0.7.x 멀티 에이전트 롤아웃 중 가장 치명적. (`shared.ts:51-66`, `claude-io.ts`, `cursor-io.ts`)
2. **H2 — FileLock 하트비트 도입 또는 스테일 조건을 AND로**: 2분 넘는 인덱싱은 흔하고, 락 탈취는 동시 기록자를 만든다. (`concurrency.ts:41-49`, `indexing-operations.ts`)
3. **H3 — 워처 error 시 dead 처리/재장착**: "codegraph를 믿어라"라는 제품 약속과 조용히 낡는 그래프는 양립 불가. (`watcher.ts:116-119`)
4. **M1+M2 — 인덱싱 재시도 경로 견고화**: `fsp.stat` try/catch + 그래머 로드 실패 시 워커 terminate/null. 대형 리포에서 indexAll 전체 실패를 막는 저비용 수정. (`bulk-retry.ts:87,143`, `parse-worker-pool.ts:95-106`)
5. **M3+M6 — 대형 코드베이스 스케일링**: 해석 fileCache에 LRU 캡(NodeCache 재사용), 파일 단위 커밋 배칭. WASM 폴백 사용자 체감 성능에 직결. (`resolution-context.ts`, `result-storage.ts`)
