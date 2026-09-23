# build backend
cd /home/docker/workspace/build/modules/MultiCamStudio/backend
rm -rf build
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j"$(nproc)"

# build and start frontend
cd /home/docker/workspace/build/modules/MultiCamStudio/frontend
rm -rf node_modules
rm -f package-lock.json
npm install
npm run dev