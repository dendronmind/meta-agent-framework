#!/usr/bin/env bash
#
# release.sh — 统一修改版本号并发布所有 npm 包
#
# 用法：
#   bash scripts/release.sh <version>
#   bash scripts/release.sh 0.4.10
#   bash scripts/release.sh patch    # 自动 +1 patch（0.4.5 → 0.4.6）
#   bash scripts/release.sh minor    # 自动 +1 minor（0.3.5 → 0.4.0）
#   bash scripts/release.sh --retry  # 版本号已改好，从编译检查开始继续发布
#
# 流程：
#   1. 计算新版本号
#   2. 更新所有 package.json
#   3. 编译检查
#   4. e2e 测试
#   5. 发布 @maf/meta-agent-server + @maf/meta-agent-client
#   6. git commit + tag（不 push）
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# ============================================================
# 颜色
# ============================================================
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

# ============================================================
# 读取当前版本
# ============================================================
CURRENT_VERSION=$(python3 -c "import json;print(json.load(open('packages/server/package.json'))['version'])")
echo ""
echo -e "${CYAN}当前版本: ${CURRENT_VERSION}${NC}"

# ============================================================
# 计算新版本
# ============================================================
INPUT="${1:-}"
RETRY=false

if [[ "$INPUT" == "--retry" ]]; then
  RETRY=true
  NEW_VERSION="$CURRENT_VERSION"
  echo -e "${YELLOW}重试模式: 使用当前版本 ${NEW_VERSION}，跳过版本修改，从编译检查开始${NC}"
  echo ""
fi

if [[ "$RETRY" == "false" ]]; then
  if [[ -z "$INPUT" ]]; then
    echo ""
    echo "用法: bash scripts/release.sh <version|patch|minor|major|--retry>"
    echo ""
    echo "  bash scripts/release.sh 0.4.10    # 指定版本"
    echo "  bash scripts/release.sh patch    # ${CURRENT_VERSION} → $(echo "$CURRENT_VERSION" | awk -F. '{print $1"."$2"."$3+1}')"
    echo "  bash scripts/release.sh minor    # ${CURRENT_VERSION} → $(echo "$CURRENT_VERSION" | awk -F. '{print $1"."$2+1".0"}')"
    echo "  bash scripts/release.sh major    # ${CURRENT_VERSION} → $(echo "$CURRENT_VERSION" | awk -F. '{print $1+1".0.0"}')"
    echo "  bash scripts/release.sh --retry  # 版本已改好，从编译检查继续"
    echo ""
    exit 1
  fi

  case "$INPUT" in
    patch) NEW_VERSION=$(echo "$CURRENT_VERSION" | awk -F. '{print $1"."$2"."$3+1}') ;;
    minor) NEW_VERSION=$(echo "$CURRENT_VERSION" | awk -F. '{print $1"."$2+1".0"}') ;;
    major) NEW_VERSION=$(echo "$CURRENT_VERSION" | awk -F. '{print $1+1".0.0"}') ;;
    *)     NEW_VERSION="$INPUT" ;;
  esac

  # 校验版本格式
  if ! echo "$NEW_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    echo -e "${RED}❌ 版本号格式错误: ${NEW_VERSION}（需要 x.y.z）${NC}"
    exit 1
  fi

  if [[ "$NEW_VERSION" == "$CURRENT_VERSION" ]]; then
    echo -e "${RED}❌ 新版本与当前版本相同: ${NEW_VERSION}${NC}"
    exit 1
  fi

  echo -e "${YELLOW}新版本: ${NEW_VERSION}${NC}"
  echo ""

  # ============================================================
  # 确认
  # ============================================================
  echo "将要更新以下文件的版本号:"
  echo "  - package.json (本地 file:out/*.tgz 依赖引用)"
  echo "  - packages/server/package.json (@maf/meta-agent-server)"
  echo "  - packages/server/src/types/index.ts (CLIENT_MIN_VERSION)"
  echo "  - packages/server/plugins/opencode-plugin-meta-agent-framework/package.json"
  echo "  - packages/server/plugins/claude-code-plugin-maf/.claude-plugin/plugin.json"
  echo "  - packages/server/plugins/codex/.codex-plugin/plugin.json"
  echo "  - packages/client/package.json (@maf/meta-agent-client)"
  echo "  - packages/client/opencode/package.json"
  echo "  - packages/client/claude-code/.claude-plugin/plugin.json"
  echo "  - packages/client/codex/.codex-plugin/plugin.json"
  echo ""
  read -p "确认发布 ${CURRENT_VERSION} → ${NEW_VERSION}? (y/N) " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "取消"
    exit 0
  fi

  # ============================================================
  # 1. 更新版本号
  # ============================================================
  echo ""
  echo -e "${CYAN}[1/6] 更新版本号...${NC}"

# 主 package.json + npm package/plugin metadata
python3 -c "
import json
version = '${NEW_VERSION}'
for f in [
  'packages/server/package.json',
  'packages/server/plugins/opencode-plugin-meta-agent-framework/package.json',
  'packages/client/package.json',
  'packages/client/opencode/package.json',
]:
    try:
        d = json.load(open(f))
        d['version'] = version
        json.dump(d, open(f, 'w'), indent=2, ensure_ascii=False)
        open(f, 'a').write('\n')
        print(f'  ✅ {f}')
    except Exception as e:
        print(f'  ❌ {f}: {e}')

root = 'package.json'
d = json.load(open(root))
deps = d.setdefault('dependencies', {})
deps['@maf/meta-agent-server'] = f'file:out/maf-meta-agent-server-{version}.tgz'
deps['@maf/meta-agent-client'] = f'file:out/maf-meta-agent-client-{version}.tgz'
json.dump(d, open(root, 'w'), indent=2, ensure_ascii=False)
open(root, 'a').write('\n')
print(f'  ✅ {root}')
"

# runtime plugin.json
python3 -c "
import json
version = '${NEW_VERSION}'
for f in [
  'packages/server/plugins/claude-code-plugin-maf/.claude-plugin/plugin.json',
  'packages/server/plugins/codex/.codex-plugin/plugin.json',
  'packages/client/claude-code/.claude-plugin/plugin.json',
  'packages/client/codex/.codex-plugin/plugin.json',
]:
    d = json.load(open(f))
    d['version'] = version
    json.dump(d, open(f, 'w'), indent=2, ensure_ascii=False)
    open(f, 'a').write('\n')
    print(f'  ✅ {f}')
"

# Client 最低版本：低版本 client 会触发 OTA
python3 -c "
from pathlib import Path
p = Path('packages/server/src/types/index.ts')
s = p.read_text()
import re
s2 = re.sub(r\"export const CLIENT_MIN_VERSION = '[^']+';\", \"export const CLIENT_MIN_VERSION = '${NEW_VERSION}';\", s)
p.write_text(s2)
print('  ✅ packages/server/src/types/index.ts')
"

  echo -e "  ${GREEN}版本号已更新为 ${NEW_VERSION}${NC}"
fi  # end of RETRY==false block

# ============================================================
# 2. 编译检查
# ============================================================
echo ""
echo -e "${CYAN}[2/6] 编译检查...${NC}"
cd packages/server && npx tsc --noEmit && cd ../..
node --check packages/server/plugins/node-daemon/daemon.mjs
node --check packages/server/bin/maf-server.mjs
node --check packages/client/bin/maf-install.mjs
echo -e "  ${GREEN}✅ 编译通过${NC}"

# ============================================================
# 3. e2e 测试
# ============================================================
echo ""
echo -e "${CYAN}[3/6] e2e 测试...${NC}"
E2E_OUTPUT=$(npm run test:e2e 2>&1)
if echo "$E2E_OUTPUT" | grep -q "全部通过"; then
  echo -e "  ${GREEN}✅ e2e 通过${NC}"
else
  echo -e "  ${RED}❌ e2e 失败，中止发布${NC}"
  echo ""
  echo "$E2E_OUTPUT" | tail -10
  echo ""
  exit 1
fi

# ============================================================
# 4. 发布 Server
# ============================================================
echo ""
echo -e "${CYAN}[4/6] 发布 @maf/meta-agent-server@${NEW_VERSION}...${NC}"
SERVER_PUB=$(cd packages/server && npm publish 2>&1)
if echo "$SERVER_PUB" | grep -q "@maf/meta-agent-server@${NEW_VERSION}"; then
  echo -e "  ${GREEN}✅ Server 发布成功${NC}"
else
  echo -e "  ${RED}❌ Server 发布失败${NC}"
  echo "$SERVER_PUB" | tail -10
  exit 1
fi

# ============================================================
# 5. 发布 Client
# ============================================================
echo ""
echo -e "${CYAN}[5/6] 发布 @maf/meta-agent-client@${NEW_VERSION}...${NC}"
cd packages/client
CLIENT_PUB=$(npm publish 2>&1)
if echo "$CLIENT_PUB" | grep -q "@maf/meta-agent-client@${NEW_VERSION}"; then
  echo -e "  ${GREEN}✅ Client 发布成功${NC}"
else
  echo -e "  ${RED}❌ Client 发布失败${NC}"
  echo "$CLIENT_PUB" | tail -10
  exit 1
fi
node bin/restore-symlinks.mjs 2>/dev/null
cd "$PROJECT_ROOT"

# ============================================================
# 6. Git commit + tag
# ============================================================
echo ""
echo -e "${CYAN}[6/6] Git commit + tag...${NC}"
git add -A
git commit -m "release: v${NEW_VERSION}"
git tag "v${NEW_VERSION}"
echo -e "  ${GREEN}✅ committed + tagged v${NEW_VERSION}${NC}"

# ============================================================
# 完成
# ============================================================
echo ""
echo "══════════════════════════════════════"
echo -e "${GREEN}  ✅ 发布完成: v${NEW_VERSION}${NC}"
echo "══════════════════════════════════════"
echo ""
echo "  @maf/meta-agent-server@${NEW_VERSION}"
echo "  @maf/meta-agent-client@${NEW_VERSION}"
echo ""
echo "  安装命令:"
echo "    npm install -g @maf/meta-agent-server"
echo "    npm install -g @maf/meta-agent-client"
echo ""
echo "  git push 需手动执行"
echo ""
