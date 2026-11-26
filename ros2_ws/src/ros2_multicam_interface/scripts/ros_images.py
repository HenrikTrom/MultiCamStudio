"""ROS image acquisition shared by calibration validation and its tests."""
from collections import deque
import os
import time
import numpy as np
import cv2


def capture_synchronized(settings, timeout=15.0, tolerance_ms=5.0):
    import rclpy
    from rclpy.context import Context
    from rclpy.node import Node
    from rclpy.executors import SingleThreadedExecutor
    from rclpy.qos import qos_profile_sensor_data
    from sensor_msgs.msg import Image

    ids = settings["serial_numbers"]
    if not ids or len(set(ids)) != len(ids):
        raise ValueError("Expected unique configured camera IDs")
    template = os.environ.get("ROS_IMAGE_TOPIC_TEMPLATE") or "/grasshopper/camera_{serial}/image_raw"
    if template.count("{serial}") != 1:
        raise ValueError("ROS_IMAGE_TOPIC_TEMPLATE must contain exactly one {serial}")
    context = Context()
    rclpy.init(context=context)
    node = Node("mcs_calibration_validation", context=context)
    executor = SingleThreadedExecutor(context=context)
    executor.add_node(node)
    queues = [deque(maxlen=32) for _ in ids]
    last = [0 for _ in ids]
    dimensions = None
    errors = []

    def receive(index, message):
        nonlocal dimensions
        sn = ids[index]
        if (message.encoding != "rgb8" or message.width <= 0 or message.height <= 0
                or message.width % 2 or message.height % 2 or message.step < message.width * 3
                or len(message.data) < message.step * message.height):
            errors.append(f"Camera {sn}: expected complete rgb8 images with positive even dimensions")
            return
        size = (message.width, message.height)
        if dimensions is None:
            dimensions = size
        if size != dimensions:
            errors.append(f"All camera images must have the same resolution: {sn} is {size}, expected {dimensions}")
            return
        stamp = message.header.stamp.sec * 1_000_000_000 + message.header.stamp.nanosec
        if stamp <= 0 or stamp < last[index] or message.header.stamp.nanosec >= 1_000_000_000:
            errors.append(f"Camera {sn}: nonzero, increasing ROS header timestamps are required")
            return
        if stamp == last[index]:
            return
        last[index] = stamp
        queues[index].append((stamp, message))

    subscriptions = []
    try:
        for index, sn in enumerate(ids):
            subscriptions.append(node.create_subscription(Image, template.replace("{serial}", sn),
                lambda message, index=index: receive(index, message), qos_profile_sensor_data))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            executor.spin_once(timeout_sec=0.05)
            if errors:
                raise ValueError(errors[0])
            while all(queues):
                stamps = [queue[0][0] for queue in queues]
                if max(stamps) - min(stamps) <= tolerance_ms * 1_000_000:
                    images = {}
                    for sn, queue in zip(ids, queues):
                        _, message = queue.popleft()
                        rgb = np.ndarray((message.height, message.width, 3), dtype=np.uint8,
                                         buffer=message.data, strides=(message.step, 3, 1))
                        images[sn] = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
                    return images, stamps
                queues[stamps.index(min(stamps))].popleft()
        missing = [sn for sn, queue in zip(ids, queues) if not queue]
        raise TimeoutError("No synchronized ROS image set arrived; check timestamps/topics: " + ", ".join(missing or ids))
    finally:
        executor.shutdown()
        node.destroy_node()
        rclpy.shutdown(context=context)
