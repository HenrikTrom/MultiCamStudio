# MCS GUI and ROS 2 image previews are built once, then launched without compilation.
ARG ROS_DISTRO=jazzy
FROM node:22-bookworm-slim AS node-base
FROM node-base AS frontend-builder
WORKDIR /build/web
COPY build/modules/MultiCamStudio/frontend/package*.json ./
RUN npm ci --no-audit --no-fund
COPY build/modules/MultiCamStudio/frontend/ ./
RUN npm run build

FROM ros:${ROS_DISTRO}-ros-base-noble AS runtime-base
ARG ROS_DISTRO
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8
SHELL ["/bin/bash", "-c"]
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libavcodec60 libavformat60 libavutil58 libswscale7 libspdlog1.12 \
      ros-${ROS_DISTRO}-sensor-msgs ros-${ROS_DISTRO}-rmw-cyclonedds-cpp \
      curl \
    && rm -rf /var/lib/apt/lists/*

# Shared Python/codec runtime; changes to application code do not rerun pip.
FROM runtime-base AS python-runtime
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv libpng16-16t64 libjpeg-turbo8 \
    && python3 -m venv --system-site-packages /opt/mcs/python \
    && /opt/mcs/python/bin/pip install --no-cache-dir numpy==1.26.4 opencv-python-headless==4.10.0.84 \
    && rm -rf /var/lib/apt/lists/*
ENV LD_LIBRARY_PATH=/opt/mcs/opencv/lib CALIBRATION_DATA=/home/docker/workspace/data

# Native calibration needs OpenCV >= 4.7, including the legacy ArUco headers.
FROM runtime-base AS opencv-builder
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake ca-certificates libpng-dev libjpeg-dev \
    && rm -rf /var/lib/apt/lists/*
ARG OPENCV_VERSION=4.10.0
RUN curl -fL --retry 3 https://codeload.github.com/opencv/opencv/tar.gz/refs/tags/${OPENCV_VERSION} -o /tmp/opencv.tar.gz \
    && curl -fL --retry 3 https://codeload.github.com/opencv/opencv_contrib/tar.gz/refs/tags/${OPENCV_VERSION} -o /tmp/contrib.tar.gz \
    && tar -xf /tmp/opencv.tar.gz -C /tmp && tar -xf /tmp/contrib.tar.gz -C /tmp \
    && cmake -S /tmp/opencv-${OPENCV_VERSION} -B /tmp/opencv-build \
      -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/mcs/opencv \
      -DOPENCV_EXTRA_MODULES_PATH=/tmp/opencv_contrib-${OPENCV_VERSION}/modules \
      -DBUILD_LIST=core,imgproc,imgcodecs,videoio,calib3d,features2d,flann,objdetect,aruco \
      -DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_opencv_apps=OFF \
      -DBUILD_JAVA=OFF -DBUILD_opencv_python3=OFF -DWITH_IPP=OFF -DWITH_ITT=OFF \
      -DWITH_OPENCL=OFF -DWITH_FFMPEG=OFF -DWITH_GSTREAMER=OFF -DWITH_GTK=OFF -DWITH_QT=OFF \
      -DWITH_TIFF=OFF -DWITH_WEBP=OFF -DWITH_OPENEXR=OFF -DWITH_OPENJPEG=OFF \
      -DWITH_LAPACK=OFF -DWITH_EIGEN=OFF -DCPU_DISPATCH= \
    && cmake --build /tmp/opencv-build -j4 && cmake --install /tmp/opencv-build

# Optional workspace for iterative colcon builds. Never used at normal startup.
FROM python-runtime AS devel-base
COPY --from=opencv-builder /opt/mcs/opencv/ /opt/mcs/opencv/
ENV CMAKE_PREFIX_PATH=/opt/mcs/opencv LD_LIBRARY_PATH=/opt/mcs/opencv/lib
COPY --from=node-base /usr/local/bin/node /usr/local/bin/node
COPY --from=node-base /usr/local/lib/node_modules/npm/ /usr/local/lib/node_modules/npm/
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential cmake pkg-config python3-colcon-common-extensions \
      libavcodec-dev libavformat-dev libavutil-dev libswscale-dev \
      libspdlog-dev nlohmann-json3-dev rapidjson-dev ffmpeg \
    && rm -rf /var/lib/apt/lists/*
ENV HOME=/tmp ROS_LOG_DIR=/tmp/mcs-ros-logs FASTDDS_BUILTIN_TRANSPORTS=UDPv4
WORKDIR /workspaces/ros2_ws
CMD ["bash"]

FROM devel-base AS calibration-builder
COPY build/modules/cpp_utils/ /tmp/cpp_utils/
RUN cmake -S /tmp/cpp_utils -B /tmp/cpp-utils-build -DCMAKE_INSTALL_PREFIX=/opt/mcs/calibration/deps \
    && cmake --build /tmp/cpp-utils-build -j4 && cmake --install /tmp/cpp-utils-build
COPY build/modules/multi-camera-calib/ /opt/mcs/calibration/source/
RUN cmake -S /opt/mcs/calibration/source -B /tmp/calibration-build \
      -DCMAKE_PREFIX_PATH="/opt/mcs/opencv;/opt/mcs/calibration/deps" \
    && cmake --build /tmp/calibration-build -j2 \
    && install -D /tmp/calibration-build/Multi_Camera_Calibration /opt/mcs/calibration/bin/Multi_Camera_Calibration
# Full development environment includes the unmodified calibration binary.
FROM calibration-builder AS build-tools
WORKDIR /workspaces/ros2_ws
CMD ["bash"]

FROM build-tools AS builder
COPY ros2_ws/src/ros2_multicam_interface/CMakeLists.txt ros2_ws/src/ros2_multicam_interface/package.xml src/ros2_multicam_interface/
COPY ros2_ws/src/ros2_multicam_interface/src/ src/ros2_multicam_interface/src/
COPY ros2_ws/src/ros2_multicam_interface/include/ src/ros2_multicam_interface/include/
RUN mkdir -p src/ros2_multicam_interface/scripts \
    && source /opt/ros/${ROS_DISTRO}/setup.bash \
    && colcon build --merge-install --install-base /opt/mcs/ros2 \
         --packages-select ros2_multicam_interface \
         --cmake-args -DCMAKE_BUILD_TYPE=Release
COPY ros2_ws/src/ros2_multicam_interface/scripts/ /opt/mcs/ros2/lib/ros2_multicam_interface/

# Development is opt-in. It has source, compilers, npm, incremental ROS builds,
# and Vite; normal startup never executes this entrypoint.
FROM builder AS devel
COPY --from=frontend-builder /build/web/ /workspaces/mcs-web/
COPY ros2_ws/src/ros2_multicam_interface/scripts/ /workspaces/ros2_ws/src/ros2_multicam_interface/scripts/
COPY --chmod=755 build/ros2/devel-entrypoint.sh /mcs-devel-entrypoint.sh
RUN chown -R 1000:1000 /workspaces
USER 1000:1000
ENV PORT=5173 MCS_API_PORT=5175 STREAMER_PORT=8080
WORKDIR /workspaces/mcs-web
EXPOSE 5173
HEALTHCHECK --interval=10s --timeout=3s --start-period=120s --retries=3 \
    CMD curl --fail --silent "http://127.0.0.1:${MCS_API_PORT}/healthz" || exit 1
ENTRYPOINT ["/mcs-devel-entrypoint.sh"]
CMD []

# The deployed image starts with ROS core, not the compiler-equipped ROS base.
FROM ros:${ROS_DISTRO}-ros-core-noble AS production-base
ARG ROS_DISTRO
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8
SHELL ["/bin/bash", "-c"]
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libavcodec60 libavformat60 libavutil58 libswscale7 libspdlog1.12 \
      libpng16-16t64 libjpeg-turbo8 python3-numpy \
      ros-${ROS_DISTRO}-rclcpp ros-${ROS_DISTRO}-rclpy ros-${ROS_DISTRO}-sensor-msgs \
      ros-${ROS_DISTRO}-rmw-fastrtps-cpp ros-${ROS_DISTRO}-rmw-cyclonedds-cpp curl \
    && rm -rf /var/lib/apt/lists/*

FROM production-base AS runtime
COPY --from=python-runtime /opt/mcs/python/ /opt/mcs/python/
ENV LD_LIBRARY_PATH=/opt/mcs/opencv/lib CALIBRATION_DATA=/home/docker/workspace/data
COPY --from=frontend-builder /usr/local/bin/node /usr/local/bin/node
COPY --from=frontend-builder /build/web/dist/ /opt/mcs/web/dist/
COPY build/modules/MultiCamStudio/frontend/server/ /opt/mcs/web/server/
COPY --from=builder /opt/mcs/ros2/ /opt/mcs/ros2/
COPY --from=builder /opt/mcs/calibration/bin/ /opt/mcs/calibration/bin/
COPY --from=builder /opt/mcs/calibration/source/cfg/ /opt/mcs/calibration/source/cfg/
COPY --from=opencv-builder /opt/mcs/opencv/ /opt/mcs/opencv/
COPY build/modules/MultiCamStudio/content/result.gif /opt/mcs/web/calibration-guide.gif
COPY cfg/CameraCalibrationSettings.json /home/docker/workspace/cfg/CameraCalibrationSettings.json
COPY --chmod=755 build/ros2/entrypoint.sh /mcs-entrypoint.sh
COPY --chmod=755 build/ros2/check-runtime.sh /usr/local/bin/mcs-check-runtime
ENV HOME=/tmp ROS_LOG_DIR=/tmp/mcs-ros-logs FASTDDS_BUILTIN_TRANSPORTS=UDPv4 \
    PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    CAMERA_CALIBRATION_FILE=/home/docker/workspace/cfg/CameraCalibrationSettings.json \
    ROS_IMAGE_TOPIC_TEMPLATE=/grasshopper/camera_{serial}/image_raw \
    PORT=5173 STREAMER_PORT=8080 STREAMER_ENCODER=libx264 STREAMER_BITRATE_MBIT=4
# Preview and recording processes run as the host user with a writable data mount.
USER 1000:1000
WORKDIR /tmp
RUN /usr/local/bin/mcs-check-runtime
EXPOSE 5173
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD curl --fail --silent "http://127.0.0.1:${PORT}/healthz" || exit 1
ENTRYPOINT ["/mcs-entrypoint.sh"]
CMD ["node", "/opt/mcs/web/server/server.mjs"]
