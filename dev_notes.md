
Inspect the logs:

docker compose logs -f multicamstudio


docker compose up -d --no-build --pull never

verify the port
curl -I http://localhost:5173

TODO list: add color calibration routine. (reference flir). also add color settings to flirmulticamera  

convert to image:
docker save my/multicamstudio_12.5.0:latest | gzip > multicamstudio.tar.gz

scp multicamstudio.tar.gz
scp docker-compose.yaml
scp .env

load image:
docker load -i ~/multicamstudio.tar.gz

docker compose up -d --no-build --pull never --force-recreate
