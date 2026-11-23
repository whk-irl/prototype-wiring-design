"""Generate the CAD and mesh fixtures under public/fixtures/.

Run from the repository root with the project venv:

    .venv/Scripts/python.exe tools/fixtures/make_models.py

Writes
  public/fixtures/enclosure/enclosure.step   build123d, assembly of 6 named, coloured bodies
  public/fixtures/arm-cad/arm-cad.step      build123d, CAD-only 3-joint arm in one rigid pose
  public/fixtures/arm-cad/axes.json         the true joint axes, computed analytically from the same transforms
  public/fixtures/chassis/chassis.glb        trimesh, glTF (metres, Y-up as the glTF spec says)
  public/fixtures/arm3/meshes/gripper_base.stl   binary STL in METRES (URDF convention)

arm3.urdf is hand-written and is not produced here.
"""
from __future__ import annotations

import json
import math
import tempfile
from pathlib import Path

import numpy as np
import trimesh
from build123d import (
    Box,
    Color,
    Align,
    Compound,
    Cylinder,
    GeomType,
    Pos,
    Rot,
    chamfer,
    export_step,
    fillet,
    export_stl,
)

Align_C, Align_MIN = Align.CENTER, Align.MIN

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "fixtures"


def make_enclosure() -> Path:
    """160 x 100 x 60 mm open-top box, 2.5 mm walls, bottom at z = 0, centred on x and y."""
    L, W, H, T = 160.0, 100.0, 60.0, 2.5

    outer = Box(L, W, H, align=(Align_C, Align_C, Align_MIN))
    cavity = Pos(0, 0, T) * Box(L - 2 * T, W - 2 * T, H, align=(Align_C, Align_C, Align_MIN))
    shell = outer - cavity
    # Two round cable holes (12 mm) through the +X side wall.
    for y in (-20.0, 20.0):
        hole = Pos(L / 2 - T / 2, y, 30.0) * Rot(Y=90) * Cylinder(6.0, T * 4)
        shell = shell - hole
    shell.label = "shell"
    shell.color = Color(0.20, 0.40, 0.80)

    # Divider wall: 2 mm thick, 40 mm tall, spanning the interior in Y.
    divider = Pos(10.0, 0, T) * Box(2.0, W - 2 * T, 40.0, align=(Align_C, Align_C, Align_MIN))
    divider.label = "divider"
    divider.color = Color(0.90, 0.60, 0.10)

    bodies = [shell, divider]
    n = 1
    for sx in (-1, 1):
        for sy in (-1, 1):
            s = Pos(60.0 * sx, 30.0 * sy, T) * Cylinder(3.0, 8.0, align=(Align_C, Align_C, Align_MIN))
            s.label = f"standoff_{n}"
            s.color = Color(0.80, 0.80, 0.80)
            bodies.append(s)
            n += 1

    asm = Compound(children=bodies, label="enclosure")
    path = OUT / "enclosure" / "enclosure.step"
    path.parent.mkdir(parents=True, exist_ok=True)
    ok = export_step(asm, str(path))
    assert ok, "export_step failed"
    return path


def _pbr(rgb):
    return trimesh.visual.material.PBRMaterial(
        baseColorFactor=[rgb[0], rgb[1], rgb[2], 1.0], metallicFactor=0.0, roughnessFactor=0.8
    )


def _colored(mesh: trimesh.Trimesh, rgb) -> trimesh.Trimesh:
    mesh.visual = trimesh.visual.TextureVisuals(material=_pbr(rgb))
    return mesh


def make_chassis() -> Path:
    """Mobile-robot chassis. Modelled Z-up in metres, written Y-up as glTF requires.

    plate    200 x 150 x 4 mm, top face at z = 46.5 mm
    motors   2 x cylinder r 12.5, length 50, along Y, at x = -60
    wheels   2 x cylinder r 30, width 20, along Y, axle z = 30
    battery  80 x 30 x 20 mm block on the plate
    """
    scene = trimesh.Scene()

    def along_y(radius, length):
        m = trimesh.creation.cylinder(radius=radius, height=length, sections=48)
        # cylinder axis is Z; rotate so it runs along Y
        m.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, [1, 0, 0]))
        return m

    def T(x, y, z):
        return trimesh.transformations.translation_matrix([x, y, z])

    plate = _colored(trimesh.creation.box(extents=[0.200, 0.150, 0.004]), (0.15, 0.55, 0.20))
    scene.add_geometry(plate, node_name="plate", geom_name="plate", transform=T(0, 0, 0.0445))
    for side, sy in (("left", 1), ("right", -1)):
        motor = _colored(along_y(0.0125, 0.050), (0.55, 0.55, 0.60))
        scene.add_geometry(motor, node_name=f"motor_{side}", geom_name=f"motor_{side}",
                           transform=T(-0.060, sy * 0.050, 0.0295))
        wheel = _colored(along_y(0.030, 0.020), (0.08, 0.08, 0.08))
        scene.add_geometry(wheel, node_name=f"wheel_{side}", geom_name=f"wheel_{side}",
                           transform=T(-0.060, sy * 0.095, 0.030))
    battery = _colored(trimesh.creation.box(extents=[0.080, 0.030, 0.020]), (0.85, 0.15, 0.15))
    scene.add_geometry(battery, node_name="battery", geom_name="battery", transform=T(0.020, 0, 0.0565))

    # Z-up -> Y-up:  (x, y, z) -> (x, z, -y)
    z_to_y = np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]], dtype=float)
    scene.apply_transform(z_to_y)

    path = OUT / "chassis" / "chassis.glb"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(scene.export(file_type="glb"))
    return path


def make_gripper_base() -> Path:
    """Gripper palm, 40 x 30 x 30 mm with a 12 mm wide slot for the finger, as a binary STL
    in metres. Origin at the centre of the bottom face (the face that meets the forearm)."""
    body = Box(40, 30, 30, align=(Align_C, Align_C, Align_MIN))
    slot = Pos(0, 0, 12) * Box(12, 40, 30, align=(Align_C, Align_C, Align_MIN))
    hole = Cylinder(4.0, 12.0, align=(Align_C, Align_C, Align_MIN))
    palm = body - slot - hole
    path = OUT / "arm3" / "meshes" / "gripper_base.stl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        tmp_stl = Path(tmp) / "palm.stl"
        export_stl(palm, str(tmp_stl), tolerance=0.01, angular_tolerance=0.1)
        m = trimesh.load_mesh(str(tmp_stl))
    m.apply_scale(0.001)  # mm -> m
    m.merge_vertices()
    m.export(str(path), file_type="stl")  # binary
    return path


# ---------------------------------------------------------------- arm-cad

def _rz(deg):
    a = math.radians(deg)
    return np.array([[math.cos(a), -math.sin(a), 0, 0], [math.sin(a), math.cos(a), 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])


def _ry(deg):
    a = math.radians(deg)
    return np.array([[math.cos(a), 0, math.sin(a), 0], [0, 1, 0, 0], [-math.sin(a), 0, math.cos(a), 0], [0, 0, 0, 1]])


def _tr(x, y, z):
    m = np.eye(4)
    m[:3, 3] = [x, y, z]
    return m


def _pt(m, p):
    return [float(v) for v in (m @ np.array([p[0], p[1], p[2], 1.0]))[:3]]


def _dir(m, d):
    v = m[:3, :3] @ np.array(d, dtype=float)
    return [float(x) for x in v / np.linalg.norm(v)]


def make_arm_cad() -> Path:
    """A 3-joint arm exported as a CAD assembly in ONE rigid pose, plus the true axes.

    Every body is built in a local frame and placed with a transform; the same
    numbers feed a numpy matrix, so the axes in axes.json are computed, not measured.
    Pose: whole upper structure yawed 25 deg about the base axis (world Z), shoulder
    rotated -35 deg and elbow -50 deg about their own local +Y axes (positive = about +Y).
    Local frames: turret (origin on the base axis, z = 60), upper arm (origin on the
    shoulder axis), forearm (origin on the elbow axis). Bars run along local +X.
    """
    YAW, SHOULDER, ELBOW = 25.0, -35.0, -50.0
    UPPER_LEN = 150.0
    C, MIN = Align_C, Align_MIN

    def along_y(radius, length, x=0.0, y=0.0, z=0.0):
        return Pos(x, y, z) * Rot(X=90) * Cylinder(radius, length)

    def filleted_pin(radius, length, kind, size, x=0.0, y=0.0, z=0.0):
        c = Cylinder(radius, length)
        ends = list(c.edges().filter_by(GeomType.CIRCLE))
        c = fillet(ends, size) if kind == "fillet" else chamfer(ends, size)
        return Pos(x, y, z) * Rot(X=90) * c

    # ---- bodies in their local frames
    base_plate = Box(120, 120, 10, align=(C, C, MIN))
    pedestal = Pos(0, 0, 10) * Cylinder(30, 50, align=(C, C, MIN)) + Pos(0, 0, 60) * Cylinder(10, 30, align=(C, C, MIN))
    # fillet (r 2) where the shaft meets the pedestal top: the shaft's cylinder then starts at z = 62
    root = [e for e in pedestal.edges().filter_by(GeomType.CIRCLE) if abs(e.radius - 10) < 1e-6 and abs(e.center().Z - 60) < 1e-6]
    assert len(root) == 1
    pedestal = fillet(root, 2.0)
    turret = Box(50, 50, 20, align=(C, C, MIN)) - Cylinder(10.5, 20, align=(C, C, MIN))
    # chamfer (1 mm) at the bore mouth, local z = 0: the bore's cylinder then starts at z = 1
    mouth = [e for e in turret.edges().filter_by(GeomType.CIRCLE) if abs(e.radius - 10.5) < 1e-6 and abs(e.center().Z) < 1e-6]
    assert len(mouth) == 1
    turret = chamfer(mouth, 1.0)
    for sy in (-1, 1):
        turret = turret + Pos(0, sy * 17, 20) * Box(30, 8, 50, align=(C, C, MIN))
    turret = turret - along_y(5.2, 60, z=50)
    shoulder_pin = filleted_pin(5, 42, z=50, kind="fillet", size=1.5)
    upper_arm = Pos(75, -4, 0) * Box(174, 12, 24)
    for x in (0, UPPER_LEN):
        upper_arm = upper_arm - along_y(5.2, 40, x=x)
    # keyway in the elbow-end hole: 3 mm wide slot towards +z, cut to radius 6.5, along the whole hole
    upper_arm = upper_arm - Pos(UPPER_LEN, 0, 3.25) * Box(3, 40, 6.5)
    elbow_pin = filleted_pin(5, 28, x=UPPER_LEN, y=2, kind="chamfer", size=1.0)
    forearm = Pos(69, 8, 0) * Box(162, 12, 24) - along_y(5.2, 40)
    # 5 mm through hole near one corner (not a joint); the large flat faces stay
    tool_plate = Pos(153, 8, 0) * Box(6, 40, 40) - Pos(153, 8 + 16, 16) * Rot(Y=90) * Cylinder(2.5, 10)
    screws = [
        Pos(158, 8 + sy * 12, sz * 12) * Rot(Y=90) * Cylinder(2, 4)
        for sy, sz in ((-1, -1), (-1, 1), (1, -1), (1, 1))
    ]

    # ---- placements: build123d Locations and the same transforms as matrices
    t_turret_loc = Pos(0, 0, 60) * Rot(Z=YAW)
    t_upper_loc = t_turret_loc * Pos(0, 0, 50) * Rot(Y=SHOULDER)
    t_fore_loc = t_upper_loc * Pos(UPPER_LEN, 0, 0) * Rot(Y=ELBOW)
    T_turret = _tr(0, 0, 60) @ _rz(YAW)
    T_upper = T_turret @ _tr(0, 0, 50) @ _ry(SHOULDER)
    T_fore = T_upper @ _tr(UPPER_LEN, 0, 0) @ _ry(ELBOW)
    I = np.eye(4)

    placed = [
        ("base_plate", base_plate, None, (0.35, 0.35, 0.38)),
        ("pedestal", pedestal, None, (0.55, 0.57, 0.62)),
        ("turret", turret, t_turret_loc, (0.20, 0.40, 0.80)),
        ("shoulder_pin", shoulder_pin, t_turret_loc, (0.90, 0.80, 0.20)),
        ("upper_arm", upper_arm, t_upper_loc, (0.90, 0.45, 0.10)),
        ("elbow_pin", elbow_pin, t_upper_loc, (0.85, 0.75, 0.20)),
        ("forearm", forearm, t_fore_loc, (0.15, 0.65, 0.30)),
        ("tool_plate", tool_plate, t_fore_loc, (0.70, 0.20, 0.60)),
    ] + [(f"screw_{i + 1}", sc, t_fore_loc, (0.10, 0.10, 0.10)) for i, sc in enumerate(screws)]
    bodies = []
    for name, shape, loc, rgb in placed:
        body = shape if loc is None else shape.moved(loc)
        body.label = name
        body.color = Color(*rgb)
        bodies.append(body)
    path = OUT / "arm-cad" / "arm-cad.step"
    path.parent.mkdir(parents=True, exist_ok=True)
    assert export_step(Compound(children=bodies, label="arm_cad"), str(path)), "export_step failed"

    # ---- ground truth, from the same numbers
    screws_all = [f"screw_{i}" for i in range(1, 5)]
    fore_set = ["forearm", "tool_plate"] + screws_all
    upper_set = ["upper_arm", "elbow_pin"] + fore_set
    turret_set = ["turret", "shoulder_pin"] + upper_set

    def pick(body, feature, T, local, radius, edge="sharp"):
        return {"body": body, "feature": feature, "edge": edge, "surface_point_mm": _pt(T, local), "radius_mm": radius}

    def wrong(body, kind, T, local):
        return {"body": body, "kind": kind, "surface_point_mm": _pt(T, local)}

    c45 = math.cos(math.radians(45))
    joints = [
        {
            "name": "base_yaw", "type": "revolute",
            "point_mm": [0.0, 0.0, 0.0], "dir": [0.0, 0.0, 1.0],
            "moving_bodies": turret_set,
            "pick": [
                # shaft cylinder spans z = 62 (fillet r 2 ends) to 90 (sharp top edge)
                pick("pedestal", "shaft", I, [10, 0, 75], 10.0, "fillet"),
                pick("pedestal", "shaft", I, [10, 0, 62.8], 10.0, "fillet"),
                # bore cylinder spans local z = 1 (chamfer 1 mm ends) to 20
                pick("turret", "hole", T_turret, [10.5, 0, 10], 10.5, "chamfer"),
                pick("turret", "hole", T_turret, [10.5, 0, 1.8], 10.5, "chamfer"),
            ],
        },
        {
            "name": "shoulder", "type": "revolute",
            "point_mm": _pt(T_turret, [0, 0, 50]), "dir": _dir(T_turret, [0, 1, 0]),
            "moving_bodies": upper_set,
            "pick": [
                # pin cylinder spans y = -19.5..19.5 (fillets r 1.5); flat end faces have radius 3.5
                pick("shoulder_pin", "shaft", T_turret, [5, 0, 50], 5.0, "fillet"),
                pick("shoulder_pin", "shaft", T_turret, [5, 18.7, 50], 5.0, "fillet"),
                pick("shoulder_pin", "face", T_turret, [0, 21, 50], 3.5, "fillet"),
                pick("turret", "hole", T_turret, [5.2, 17, 50], 5.2),
                pick("upper_arm", "hole", T_upper, [5.2, -4, 0], 5.2),
            ],
        },
        {
            "name": "elbow", "type": "revolute",
            "point_mm": _pt(T_upper, [UPPER_LEN, 0, 0]), "dir": _dir(T_upper, [0, 1, 0]),
            "moving_bodies": fore_set,
            "pick": [
                # pin cylinder spans y = -11..15 (chamfers 1 mm); flat end faces have radius 4
                pick("elbow_pin", "shaft", T_upper, [UPPER_LEN + 5, 2, 0], 5.0, "chamfer"),
                pick("elbow_pin", "shaft", T_upper, [UPPER_LEN + 5, 14.4, 0], 5.0, "chamfer"),
                pick("elbow_pin", "face", T_upper, [UPPER_LEN, 16, 0], 4.0, "chamfer"),
                pick("upper_arm", "hole", T_upper, [UPPER_LEN + 5.2, -4, 0], 5.2),
                # keyed hole: the slot is towards +z (angle 0..17 deg either side); this point is at 40 deg
                pick("upper_arm", "hole", T_upper, [UPPER_LEN + 5.2 * math.sin(math.radians(40)), -4, 5.2 * math.cos(math.radians(40))], 5.2, "keyway"),
                pick("forearm", "hole", T_fore, [5.2, 8, 0], 5.2),
            ],
        },
    ]
    not_axes = [
        wrong("tool_plate", "flat_rectangle", T_fore, [150, 8, -8]),
        wrong("base_plate", "flat_rectangle", I, [40, -40, 10]),
        wrong("forearm", "flat_rectangle", T_fore, [75, 14, 0]),
        wrong("upper_arm", "flat_side_of_bar", T_upper, [75, -10, 0]),
        # on the fillet surfaces themselves (45 deg round each blend)
        wrong("shoulder_pin", "fillet", T_turret, [3.5 + 1.5 * c45, 19.5 + 1.5 * c45, 50]),
        wrong("pedestal", "fillet", I, [12 - 2 * c45, 0, 62 - 2 * c45]),
    ]
    truth = {"units": "mm", "joints": joints, "not_axes": not_axes}
    (path.parent / "axes.json").write_text(json.dumps(truth, indent=2) + "\n", encoding="utf8")
    return path


if __name__ == "__main__":
    for fn in (make_enclosure, make_chassis, make_gripper_base, make_arm_cad):
        p = fn()
        print(f"{fn.__name__}: {p.relative_to(ROOT)} ({p.stat().st_size} bytes)")
