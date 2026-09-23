ARG UBUNTU_IMAGE_VERSION
ARG CUDA_VERSION=12.3

FROM nvidia/cuda:${CUDA_VERSION}-devel-ubuntu${UBUNTU_IMAGE_VERSION} AS opencv-builder

LABEL maintainer="Henrik Trommer <henrik.trommer@uni-goettingen.de>"

SHELL ["/bin/bash","-c"]

# Set system timezone to UTC, Install GPG and certificate tools for adding external repositories
RUN echo 'Etc/UTC' > /etc/timezone \
    && ln -s /usr/share/zoneinfo/Etc/UTC /etc/localtime \
    && apt-get update \
    && apt-get install -q -y --no-install-recommends \
    tzdata \
    dirmngr \
    gnupg2 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

################################################################
# Essential build tools and dependencies
################################################################

# Install build tools and software properties
RUN apt-get update --fix-missing && apt-get install --no-install-recommends -y \
    software-properties-common \
    build-essential \
    wget git bzip2 ca-certificates zlib1g-dev \
    libncurses5-dev libgdbm-dev libglib2.0-0 libxext6 libsm6 \
    libxrender1 libffi-dev libusb-1.0-0-dev \
    tree nano libeigen3-dev wget curl \
    libavdevice-dev \
    zlib1g unzip mlocate \
    sudo \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

################################################################
## CMake Installation (custom version)
################################################################

ARG CMAKE_VERSION
ENV CMAKE_VERSION=${CMAKE_VERSION}

# Install custom version of CMake
RUN apt-get update && apt-get install -y ca-certificates \
    && wget https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/cmake-${CMAKE_VERSION}-linux-x86_64.sh \
    && mkdir /opt/cmake \
    && sh cmake-${CMAKE_VERSION}-linux-x86_64.sh --skip-license --prefix=/opt/cmake \
    && ln -s /opt/cmake/bin/cmake /usr/local/bin/cmake \
    && rm cmake-${CMAKE_VERSION}-linux-x86_64.sh

################################################################
## Vision Dependencies Installation
################################################################

# Re-declare args as they're not preserved after `FROM`
ARG UBUNTU_IMAGE_VERSION
ARG CUDA_VERSION
ARG CUDA_ARCH_BIN
ARG OPENCV_VERSION
ARG UID
ARG GID
ARG CPP_OPTIMIZATIONS

# Export args as environment variables
ENV UBUNTU_IMAGE_VERSION=${UBUNTU_IMAGE_VERSION}
ENV CUDA_VERSION=${CUDA_VERSION}
ENV CUDA_ARCH_BIN=${CUDA_ARCH_BIN}
ENV OPENCV_VERSION=${OPENCV_VERSION}
ENV CPP_OPTIMIZATIONS=${CPP_OPTIMIZATIONS}


RUN mkdir /opt/vision_dependencies
################################################################
# OpenCV Installation
################################################################
# Keep application and other dependency changes out of the OpenCV cache key.
COPY ./vision_dependencies/opencv/install.sh /opt/vision_dependencies/opencv/install.sh

# Install OpenCV (custom build)
WORKDIR /opt/vision_dependencies/opencv/
RUN chmod +x install.sh && ./install.sh

FROM nvidia/cuda:${CUDA_VERSION}-runtime-ubuntu${UBUNTU_IMAGE_VERSION} AS multicamstudio

ARG UBUNTU_IMAGE_VERSION
ARG CUDA_VERSION
ARG CUDA_ARCH_BIN
ARG OPENCV_VERSION
ARG UID
ARG GID
ARG CPP_OPTIMIZATIONS
ARG FLIR_CAMERA_COUNT
# Export args as environment variables
ENV UBUNTU_IMAGE_VERSION=${UBUNTU_IMAGE_VERSION}
ENV CUDA_VERSION=${CUDA_VERSION}
ENV CUDA_ARCH_BIN=${CUDA_ARCH_BIN}
ENV OPENCV_VERSION=${OPENCV_VERSION}
ENV CPP_OPTIMIZATIONS=${CPP_OPTIMIZATIONS}
ENV FLIR_CAMERA_COUNT=${FLIR_CAMERA_COUNT}

LABEL maintainer="Henrik Trommer <henrik.trommer@uni-goettingen.de>"

COPY --from=opencv-builder /usr/local /usr/local
COPY --from=opencv-builder /opt/cmake /opt/cmake

# Fail here if the builder did not produce a usable OpenCV installation.
RUN test -s /usr/local/lib/cmake/opencv4/OpenCVConfig.cmake && ldconfig

SHELL ["/bin/bash","-c"]

# Set system timezone to UTC, Install GPG and certificate tools for adding external repositories
RUN echo 'Etc/UTC' > /etc/timezone \
    && ln -s /usr/share/zoneinfo/Etc/UTC /etc/localtime \
    && apt-get update \
    && apt-get install -q -y --no-install-recommends \
    tzdata \
    dirmngr \
    gnupg2 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

################################################################
# Essential build tools and dependencies
################################################################

# Install build tools and software properties
RUN apt-get update --fix-missing && apt-get install --no-install-recommends -y \
    software-properties-common \
    build-essential \
    rapidjson-dev libspdlog-dev libfmt-dev \
    wget git bzip2 ca-certificates zlib1g-dev \
    libncurses5-dev libgdbm-dev libglib2.0-0 libxext6 libsm6 \
    libxrender1 libffi-dev libusb-1.0-0-dev \
    qt5-default \
    tree nano libeigen3-dev wget curl \
    libavdevice-dev \
    zlib1g unzip mlocate \
    sudo \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

################################################################
## Python Environment Setup
################################################################

# Install Python and pip
RUN apt-get update && apt-get install --no-install-recommends -y \
    python3 \
    python3-pip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install numerical and visualization packages
RUN pip3 install --no-cache-dir numpy==1.24.4 tqdm cairosvg
RUN pip3 install --no-cache-dir opencv-contrib-python
RUN pip3 install --no-cache-dir matplotlib pillow jsonpickle rich

################################################################
## X11 and debugging utilities
################################################################

# Enable X11 forwarding and archive tools
RUN apt-get update -y && apt-get install -y \
    x11-apps xauth zip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

################################################################
## CMake (custom version)
################################################################

ARG CMAKE_VERSION
ENV CMAKE_VERSION=${CMAKE_VERSION}

## Install: Spinnaker
################################################################

RUN mkdir /opt/spinnaker
COPY ./spinnaker/ /opt/spinnaker/
WORKDIR /opt/spinnaker
ENV DEBIAN_FRONTEND="noninteractive"
ENV DEBIAN_FRONTEND="teletype"
RUN chmod +x ./install_spinnaker_auto.sh
RUN chmod +x ./install_spinnaker.sh && ./install_spinnaker.sh

################################################################
# Install Modules
################################################################

RUN mkdir /opt/modules
COPY ./modules/ /opt/modules/
WORKDIR /opt/modules/cpp_utils
RUN rm -rf build; mkdir build && chmod +x ./build_install.sh && ./build_install.sh
################################################################
# Extra packages
################################################################
RUN apt-get update && apt-get install -y \
    pybind11-dev \
    python3-dev \
    python3-pip \
    python3-setuptools \
    python3-numpy \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
################################################################
# Install libflirmulticamera
################################################################
RUN apt-get update && apt-get install -y npm --fix-missing \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
COPY ./modules/flirmulticamera/ /opt/modules/flirmulticamera/
WORKDIR /opt/modules/flirmulticamera
RUN rm -rf build; mkdir build && chmod +x ./build_install.sh && ./build_install.sh
## Build: multi-camera-calib
################################################################
WORKDIR /opt/modules/multi-camera-calib/scripts
RUN chmod +x ./build.sh && ./build.sh
################################################################
## Install NVM
################################################################
ENV NVM_DIR=/opt/nvm
RUN mkdir -p "$NVM_DIR" \
    && curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash \
    && . "$NVM_DIR/nvm.sh" \
    && nvm install 20 \
    && nvm use 20 \
    && nvm alias default 20 \
    && ln -sf "$(which node)" /usr/local/bin/node \
    && ln -sf "$(which npm)" /usr/local/bin/npm \
    && ln -sf "$(which npx)" /usr/local/bin/npx \
    && chmod -R a+rX "$NVM_DIR"

################################################################
## System Fixes and Quality of Life Improvements
################################################################

# Workaround for broken apt-get cache cleanup in some base images
RUN rm /etc/apt/apt.conf.d/docker-clean &&\
    apt-get update

# Enable case-insensitive tab completion
RUN echo 'set completion-ignore-case On' >> /etc/inputrc

################################################################
## Final Setup: User Environment and Permissions
################################################################

# Create non-root user with sudo permissions
COPY ./setup/user.sh /tmp/user.sh
RUN chmod +x /tmp/user.sh && /tmp/user.sh

ARG FLIR_GID
ENV FLIR_GID=${FLIR_GID}
RUN groupadd -g $FLIR_GID flirimaging
# add users to the flirimaging group
RUN usermod -a -G flirimaging docker
################################################################
## Final Setup: User Environment and Permissions
################################################################

# Create non-root user with sudo permissions
COPY ./setup/user.sh /tmp/user.sh
RUN chmod +x /tmp/user.sh && /tmp/user.sh

# Set default workspace
WORKDIR /home/docker/workspace

# Add custom shell configuration
COPY .bashrc /home/docker/.bashrc

# Remove potentially conflicting OpenCV libraries from system
RUN rm -rf /usr/lib/x86_64-linux-gnu/libopencv*
RUN rm -rf /usr/lib/x86_64-linux-gnu/cmake/opencv4/

# Update file search database
RUN updatedb

# Switch to non-root user
USER docker
