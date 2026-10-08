
Inspect the logs:

docker compose logs -f multicamstudio


docker compose up -d --no-build --pull never

verify the port
curl -I http://localhost:5173

convert to image:
docker save my/multicamstudio:latest | gzip > multicamstudio.tar.gz

scp multicamstudio.tar.gz
scp docker-compose.yaml
scp .env

load image:
docker load -i ~/multicamstudio.tar.gz

docker compose up -d --no-build --pull never --force-recreate