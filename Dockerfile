# 서무비서 — 기관 내부 서버(온프레미스)·클라우드 어디서나 실행
#   docker build -t secretary .
#   docker run -p 8000:8000 --env-file .env -v $(pwd)/regulations:/app/regulations \
#     -v $(pwd)/secretary:/app/secretary -v $(pwd)/regulations_manifest.json:/app/regulations_manifest.json secretary
# 볼륨을 붙이면 화면에서 올린 내규·기관 절차·기관 설정이 컨테이너를 다시 만들어도 남는다.
# 1단계: 한글 서식 엔진(kordoc, Node 20+) 설치
FROM node:22-slim AS forms
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=optional

FROM python:3.12-slim
WORKDIR /app
COPY --from=forms /usr/local/bin/node /usr/local/bin/node
COPY --from=forms /app/node_modules /app/node_modules
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/*
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn
COPY . .
EXPOSE 8000
CMD ["gunicorn", "-w", "2", "-b", "0.0.0.0:8000", "--timeout", "120", "api_server:app"]
