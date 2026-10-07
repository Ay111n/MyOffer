.PHONY: backend frontend ai-install ai-test test test-unit lint openapi gen-api e2e regression

# 使用项目开发环境，避免系统 Python 未安装 ruff 或全局 PATH 未激活 venv。
ifeq ($(OS),Windows_NT)
BACKEND_PYTHON = .venv/Scripts/python.exe
else
BACKEND_PYTHON = .venv/bin/python
endif

backend:
	cd backend && uvicorn app.main:app --reload --port 8000

frontend:
	cd frontend && npm run dev

ai-install:
	cd backend/ai-runtime && npm ci --omit=dev

ai-test:
	cd backend/ai-runtime && npm test

test:
	cd backend && pytest -q

# 规则引擎纯单元/金标准（只加载 YAML 规则，不启动 FastAPI / 进程内 DB，适合快速回归）
test-unit:
	cd backend && pytest -q tests/test_report_engine.py tests/test_rules_invariants.py tests/test_fact_value_bounds.py

lint:
	cd backend && $(BACKEND_PYTHON) -m ruff check app tests
	cd frontend && npm run lint

openapi:
	cd backend && python -m app.export_openapi > openapi.json
	cp backend/openapi.json openapi.json

gen-api: openapi
	cd frontend && npm run gen:api

# 前端 vitest 单测 + Playwright 冒烟（无需数据库）
e2e:
	cd frontend && npm run test && npx playwright test

# 生产形态 e2e：对 next build 的静态 out/ 跑同一套用例（含异常路径），
# static-server.mjs 模拟 nginx 的路由回退与 /api 反代——发布前必跑
e2e-prod:
	cd frontend && npm run build
	cd frontend && npx playwright test -c playwright.prod.config.ts

# release regression：后端全量 + 前端四件套
regression:
	cd backend && pytest -q
	cd backend/ai-runtime && npm test
	cd backend && $(BACKEND_PYTHON) -m ruff check app tests
	cd frontend && npm run lint
	cd frontend && npx tsc --noEmit
	cd frontend && npm run test
	cd frontend && npm run build
