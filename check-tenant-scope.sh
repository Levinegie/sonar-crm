#!/bin/bash

echo "🔍 检查所有 API 路由的租户隔离中间件"
echo ""

for file in src/routes/*.js; do
  echo "📄 检查文件: $file"

  # 查找所有 router 定义，检查是否有 tenantScope
  grep -n "router\.\(get\|post\|put\|delete\|patch\)" "$file" | while read line; do
    line_num=$(echo "$line" | cut -d: -f1)
    content=$(echo "$line" | cut -d: -f2-)

    # 跳过注释行
    if echo "$content" | grep -q "^[[:space:]]*//"; then
      continue
    fi

    # 检查是否包含 tenantScope
    if ! echo "$content" | grep -q "tenantScope"; then
      # 检查是否是公开路由（如登录、注册）
      if echo "$content" | grep -qE "(login|register|health|public)"; then
        continue
      fi

      echo "  ⚠️  第 $line_num 行可能缺少 tenantScope:"
      echo "     $content"
    fi
  done
  echo ""
done

echo "✅ 检查完成"
