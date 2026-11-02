#!/bin/bash
set -euo pipefail

test -e ${OPENCV_VERSION}.zip || wget https://github.com/opencv/opencv/archive/refs/tags/${OPENCV_VERSION}.zip
test -e opencv-${OPENCV_VERSION} || unzip ${OPENCV_VERSION}.zip
test -e opencv_extra_${OPENCV_VERSION}.zip || wget -O opencv_extra_${OPENCV_VERSION}.zip https://github.com/opencv/opencv_contrib/archive/refs/tags/${OPENCV_VERSION}.zip
test -e opencv_contrib-${OPENCV_VERSION} || unzip opencv_extra_${OPENCV_VERSION}.zip

cd opencv-${OPENCV_VERSION}

# Reconfigure existing builds too, so changed options are applied.
mkdir -p build
cd build

# OpenCV adds transitive dependencies (features2d, flann, objdetect) automatically.
# highgui is required by flirmulticamera's native stream_synced_videos utility.
# GPU video encoding uses FFmpeg directly; no OpenCV CUDA modules are used.
cmake -D CMAKE_BUILD_TYPE=RELEASE \
    -D BUILD_LIST=core,imgproc,imgcodecs,videoio,highgui,calib3d,aruco \
    -D CMAKE_CXX_FLAGS="${CPP_OPTIMIZATIONS}" \
    -D CMAKE_C_FLAGS="${CPP_OPTIMIZATIONS}" \
    -D CMAKE_INSTALL_PREFIX=/usr/local/ \
    -D WITH_TBB=ON \
    -D ENABLE_FAST_MATH=1 \
    -D WITH_CUBLAS=OFF \
    -D WITH_CUDA=OFF \
    -D BUILD_opencv_cudacodec=OFF \
    -D WITH_CUDNN=OFF \
    -D OPENCV_DNN_CUDA=OFF \
    -D WITH_QT=OFF \
    -D WITH_OPENGL=ON \
    -D BUILD_opencv_apps=OFF \
    -D BUILD_TESTS=OFF \
    -D BUILD_PERF_TESTS=OFF \
    -D BUILD_JAVA=OFF \
    -D BUILD_opencv_python2=OFF \
    -D BUILD_opencv_python3=OFF \
    -D OPENCV_GENERATE_PKGCONFIG=ON \
    -D OPENCV_PC_FILE_NAME=opencv.pc \
    -D OPENCV_ENABLE_NONFREE=OFF \
    -D OPENCV_EXTRA_MODULES_PATH=../../opencv_contrib-${OPENCV_VERSION}/modules \
    -D INSTALL_PYTHON_EXAMPLES=OFF \
    -D INSTALL_C_EXAMPLES=OFF \
    -D BUILD_EXAMPLES=OFF \
    -D WITH_FFMPEG=ON \
    ..

cmake --build . --parallel "$(nproc)"
sudo "$(command -v cmake)" --install .
test -s /usr/local/lib/cmake/opencv4/OpenCVConfig.cmake

cd ../.. && rm ${OPENCV_VERSION}.zip && rm opencv_extra_${OPENCV_VERSION}.zip
