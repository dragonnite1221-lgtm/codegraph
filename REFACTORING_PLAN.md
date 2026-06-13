# CodeGraph 리팩토링 계획

작성일: 2026-06-11

## 1. 현황 요약

- `src/` TypeScript 약 25,300줄 (500줄 초과 파일 9개), 언어 extractor 16종, 테스트 파일 22개(621 테스트)
- `npx tsc --noEmit` — **통과**
- `npm test` — **612 통과 / 9 실패** (이 컨테이너 기준; 아래 분석 참조)
- 하우스 룰 3종 지침 파일(server-instructions.ts / instructions-template.ts / codegraph.mdc) — 도구 목록 9종이 **3개 파일 모두 일치** (동기화 양호)
- `: any`/`as any` 20건(낮음), `@ts-ignore` 0건, 빈 catch 0건 — 타입/에러 위생 양호

## 2. 발견된 문제점

### High

- **테스트 9건 실패 — 환경 의존성 추정, 원인 분류 필요**:
  - `sync.test.ts` Git-based sync 5건 + `extraction.test.ts` 서브모듈 1건(issue #147) — 샌드박스 내 git 동작(임시 리포 user 설정, 서브모듈) 의존 추정
  - `glyphs.test.ts` macOS 글리프 1건 — `{ ok: '[OK]' }` vs `{ ok: '✓' }`: 플랫폼/TERM 감지 결과가 기대와 다름
  - `mcp-initialize.test.ts` 2건(issue #172) — 5초/10초 타임아웃, 느린 환경에서 플레이크 가능
  로컬/CI 어디서든 깨질 수 있는 테스트는 회귀 신호를 무력화한다. 환경 의존 테스트의 가드(skip 조건) 또는 환경 셋업 보강이 필요하다.

### Medium

- **거대 파일 9개 (500줄 초과)** — `extraction/tree-sitter.ts` 2,548줄, `mcp/tools.ts` 1,739줄, `db/queries.ts` 1,454줄, `extraction/index.ts` 1,447줄, `bin/codegraph.ts` 1,363줄, `context/index.ts` 1,134줄. 특히 `tree-sitter.ts`는 16개 언어 wrapper 로직이 응집 없이 누적되는 구조라 언어 추가마다 더 커진다.
- **`mcp/tools.ts` 단일 파일에 모든 MCP 도구 정의+핸들러 동거** — 도구 추가 시 충돌 표면이 큼. 도구별 모듈 분리 여지.
- **CLI(`bin/codegraph.ts`) 1,363줄** — 서브커맨드 11개가 한 파일. commander 커맨드별 파일 분리 여지.

### Low

- `: any` 20건 — 핫스팟 위주 점진 제거 대상
- 언어 extractor 16종 간 보일러플레이트(노드 매핑 패턴) 중복 — 공통 베이스 추출 여지 (단, 언어별 차이가 커서 과추상화 리스크 있음)

## 3. 단계적 개선 계획

> 하우스 룰: `src/installer/` 변경은 반드시 `__tests__/installer-targets.test.ts` 보강 + CHANGELOG 항목을 동반한다. MCP 도구 동작 변경 시 지침 3종 파일을 함께 갱신한다.

### Phase 1 — 테스트 신호 복구 (즉시)

| 작업 | 내용 | 규모 | 리스크 | 검증 |
|---|---|---|---|---|
| 실패 9건 원인 분류 | CI(github actions)와 로컬 macOS/Linux에서 각각 실행해 "환경 의존 vs 실제 회귀" 판정 | S | 없음 | 판정 기록 |
| 환경 가드 추가 | git 의존 테스트에 사전조건 셋업(임시 git config) 또는 조건부 skip, glyphs 테스트에 플랫폼 mock, MCP 핸드셰이크 타임아웃 여유 상향 | M | skip 남용 시 커버리지 약화 — skip은 사유 주석 필수 | `npm test` 전 환경 green |

### Phase 2 — 거대 파일 분해

| 작업 | 내용 | 규모 | 리스크 | 검증 |
|---|---|---|---|---|
| tree-sitter.ts 분해 | 언어 wrapper 로딩/파싱 코어와 언어별 설정 분리 (`languages/`와 대칭 구조로) | L | 추출 결과 회귀 — evaluation 러너로 사전/사후 점수 비교 | `npm test` + `EVAL_CODEBASE=/path/to/indexed/codebase npm run eval` |
| mcp/tools.ts 분해 | 도구별 모듈 + 레지스트리 패턴. server-instructions.ts와 도구 목록 일치 검사 스크립트 추가 | M | MCP 인터페이스 회귀 | mcp 테스트 + 지침 3종 diff 검사 |
| bin/codegraph.ts 분해 | 서브커맨드별 파일 분리 | M | CLI 회귀 | CLI smoke 테스트 |
| db/queries.ts 정리 | QueryBuilder를 도메인(nodes/edges/files/fts)별 분리 | M | prepared statement 누락 | sqlite-backend 테스트 |

### Phase 3 — 장기

- 지침 3종 파일(server-instructions / instructions-template / codegraph.mdc)의 동기화를 단일 소스에서 생성하는 방식으로 전환 (현재는 수동 동기화 — 지금은 일치하지만 구조적으로 어긋나기 쉬움)
- `: any` 20건 점진 제거 + `noImplicitAny` 강화 검토
- 언어 extractor 공통 패턴의 신중한 베이스 추출 (NodeKind/EdgeKind 매핑 테이블화)

## 4. 검증 체크리스트

- [ ] `npx tsc --noEmit` 통과 유지
- [ ] `npm test` — CI(Linux)와 macOS 모두 실패 0건
- [ ] `EVAL_CODEBASE=/path/to/indexed/codebase npm run eval` 점수 리팩토링 전후 동등 이상
- [ ] installer 변경 시 installer-targets 계약 테스트 + CHANGELOG 동반 확인
- [x] MCP 도구 변경 시 지침 3종 파일 도구 목록 일치 (이번 분해는 MCP 동작 무변경)

## 5. 진행 현황 — Phase 2 완료 (2026-06-13)

거대 파일(500줄 초과) 11개 중 **10개를 임계 아래로 분해 완료**. 모든 변경은
재export/위임으로 공개 API·import 경로를 보존(blast radius 0)했고, 전 단계
`npm test` 736→738 통과 + 타입체크 통과. 추출/스코어링 계열은 **TypeScript +
Python 두 언어 그래프-동일성 하니스로 바이트 단위 동작 보존을 검증**했다
(`__tests__/graph-snapshot.test.ts`로 정식 테스트화).

| 파일 | 전→후 | 분리 모듈 |
|---|---|---|
| extraction/tree-sitter.ts | 1199→446 | `extractors-decl.ts`, `extractors-misc.ts`, `extractors.ts`(barrel) — extractX 19개 함수 분리 |
| context/index.ts | 1134→239 | `context-search.ts`, `context-helpers.ts` — findRelevantContext 분할 |
| index.ts | 988→826 | `lifecycle.ts`, `indexing-operations.ts` (※ 공개 API 파사드라 의도적으로 500↑ 유지) |
| extraction/index.ts | 943→493 | `parse-worker-pool.ts`, `bulk-parse.ts`, `bulk-retry.ts`, `detection-context.ts`, `parse-result-predicates.ts` |
| types.ts | 841→479 | `config-types.ts`, `context-types.ts` |
| resolution/index.ts | 768→438 | `resolution-context.ts`, `builtin-symbols.ts`, `edge-builder.ts` |
| resolution/import-resolver.ts | 731→359 | `import-extractors.ts` |
| graph/traversal.ts | 641→477 | `impact.ts`, `hierarchy.ts` |
| utils.ts | 566→73 | `path-security.ts`, `concurrency.ts` |
| db/search-queries.ts | 548→273 | `search-internals.ts` |
| mcp/explore-output.ts | 518→348 | `explore-clusters.ts` |
| db/queries.ts | 722→498 | `node-queries.ts` |

> 검증 비고: 계획서가 권장한 `EVAL_CODEBASE … npm run eval`은 Elasticsearch(Java)
> 코드베이스를 전제하므로 대체로, 동일 코드베이스를 재인덱싱해 그래프(노드/엣지
> 전수 + 검색/컨텍스트 결과)가 바이트 동일한지 비교하는 하니스로 검증했다 —
> 순수 리팩토링에는 eval 점수보다 강한 보장이다.

> 잔여: `index.ts`(826)는 CLAUDE.md가 명시한 단일 공개 API 파사드라 의도적으로
> 유지. mcp/tools.ts·bin/codegraph.ts는 이전 작업에서 이미 임계 아래로 분해됨.
- [ ] MCP 도구 변경 시 지침 3종 파일 도구 목록 일치
