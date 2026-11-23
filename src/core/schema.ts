/**
 * The design file (`design.json`). Every stage of the pipeline reads and
 * writes this one structure.
 *
 * Conventions
 * - Lengths are millimetres. Numeric fields carry a unit suffix (`_mm`, `_a`).
 * - Rotations are unit quaternions `[x, y, z, w]`.
 * - Joint `lower`, `upper` and `value` are radians for revolute and continuous
 *   joints and millimetres for prismatic joints.
 * - Geometry is never stored here. Meshes are re-imported from `scene.sources`
 *   and addressed by `MeshRef.id`.
 * - Everything attached to the machine (zones, components, route segments) is
 *   expressed in the frame of the link it sits on, so it moves with that link.
 *
 * The sections after `parts` are filled by later milestones. Their shape
 * may still change before schema version 1 is frozen at the first release.
 */
import { z } from 'zod';

export const SCHEMA_VERSION = 1 as const;

export const IdSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, 'ids use letters, digits and _ . : - and start with a letter or digit');

export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
export const QuatSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

/** A rigid transform: position in mm, rotation as a unit quaternion [x, y, z, w]. */
export const PoseSchema = z.strictObject({
  p_mm: Vec3Schema,
  q: QuatSchema,
});

// ---------------------------------------------------------------- scene

/** `builtin` is a model the app generates itself (the demo arm, the
 *  performance test model); its `uri` is `builtin:<name>` and no file exists. */
export const SourceKindSchema = z.enum(['step', 'iges', 'glb', 'gltf', 'stl', 'obj', 'urdf', 'builtin']);

/** A model file the scene was imported from. */
export const SourceSchema = z.strictObject({
  id: IdSchema,
  kind: SourceKindSchema,
  /** File name or project-relative path, forward slashes. */
  uri: z.string().min(1),
  /** Scale from the file's length unit to millimetres (URDF and glTF: 1000). */
  mm_per_unit: z.number().positive(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

/**
 * One triangle mesh of a link, in mm.
 *
 * The importer delivers every mesh's vertices in the frame of the link it
 * imported into, and `pose` is absent. When the user regroups meshes into
 * links of their own (a CAD file has no joints; see `articulation.ts`), the
 * vertices stay exactly as imported and `pose` records where that imported
 * geometry sits in its new link's frame:
 *
 *   point in link frame = pose * imported vertex
 *
 * Re-importing the source file therefore always reproduces the same geometry.
 */
export const MeshRefSchema = z.strictObject({
  id: IdSchema,
  source: IdSchema,
  /** Name or path of the node inside the source file, as imported. */
  node: z.string(),
  /** Imported geometry frame in the link frame. Absent means identity. */
  pose: PoseSchema.optional(),
  /** Triangle count at import time. Zones index triangles, so a mismatch on
   *  re-import means the zones of this mesh can no longer be trusted. */
  tri_count: z.int().nonnegative(),
});

export const LinkSchema = z.strictObject({
  id: IdSchema,
  name: z.string(),
  /**
   * Present on a link the user created by splitting another (see
   * `articulation.ts`); absent on links that came from the importer. Every
   * mesh on a user-defined link must carry an explicit `pose`, so a file that
   * lost its poses is rejected instead of opening with parts in the wrong
   * place.
   */
  user_defined: z.literal(true).optional(),
  meshes: z.array(MeshRefSchema).default([]),
});

export const JointTypeSchema = z.enum(['fixed', 'revolute', 'continuous', 'prismatic']);

/**
 * Same semantics as URDF: `origin` is the child link frame expressed in the
 * parent link frame at value 0; the joint then moves the child about or along
 * `axis`, which is given in the child frame.
 *
 *   T(parent -> child) = origin * motion(axis, value)
 */
export const JointSchema = z.strictObject({
  id: IdSchema,
  name: z.string(),
  type: JointTypeSchema,
  parent: IdSchema,
  child: IdSchema,
  origin: PoseSchema,
  axis: Vec3Schema.default([0, 0, 1]),
  /** Required for revolute and prismatic joints. */
  limit: z.strictObject({ lower: z.number(), upper: z.number() }).optional(),
  /** Pose the design was last saved in. */
  value: z.number().default(0),
});

export const SceneSchema = z.strictObject({
  sources: z.array(SourceSchema).default([]),
  links: z.array(LinkSchema).default([]),
  joints: z.array(JointSchema).default([]),
});

// ---------------------------------------------------------------- zones

export const ZoneKindSchema = z.enum(['mount_allowed', 'keep_out']);

/** A user-painted area on one mesh. */
export const ZoneSchema = z.strictObject({
  id: IdSchema,
  name: z.string(),
  kind: ZoneKindSchema,
  link: IdSchema,
  mesh: IdSchema,
  /** Run-length encoded triangle indices: [start, count, start, count, ...],
   *  ascending and non-overlapping. See `triangles.ts`. */
  triangles: z.array(z.int().nonnegative()).default([]),
});

// ---------------------------------------------------------------- components

/** An instance of a library part mounted on a link. */
export const ComponentSchema = z.strictObject({
  id: IdSchema,
  name: z.string(),
  /** Part id in the parts library. */
  part: z.string().min(1),
  link: IdSchema,
  /** Part frame in the link frame. The part frame has its origin at the centre
   *  of the mounting face and +Z pointing away from the surface. */
  pose: PoseSchema,
  /** Zone the part was placed in, if any. */
  zone: IdSchema.optional(),
});

// ---------------------------------------------------------------- connections

export const InterfaceSchema = z.enum([
  'power',
  'i2c',
  'spi',
  'uart',
  'can',
  'rs485',
  'usb2',
  'usb3',
  'ethernet',
  'mipi_csi',
  'mipi_dsi',
  'analog',
  'gpio',
  'pwm',
  'motor_phase',
  'encoder',
  'other',
]);

export const PortRefSchema = z.strictObject({
  component: IdSchema,
  port: IdSchema,
});

/** One point-to-point electrical connection between two ports. A bus with
 *  several devices is several connections. */
export const ConnectionSchema = z.strictObject({
  id: IdSchema,
  name: z.string().optional(),
  from: PortRefSchema,
  to: PortRefSchema,
  interface: InterfaceSchema,
  current_a: z.number().nonnegative().optional(),
  voltage_v: z.number().optional(),
});

// ---------------------------------------------------------------- parts

/**
 * A place on a part where a cable attaches.
 *
 * Port frame: origin at the mouth of the connector, where the mating plug
 * goes in. +X is the direction the cable leaves. +Y runs along the row of
 * contacts and +Z across the rows; for a connector lying on a board, +Z is
 * normally the board's own +Z.
 */
export const PortSchema = z.strictObject({
  id: IdSchema,
  name: z.string().optional(),
  /** Connector family id in the connector library, for example `jst-sh` or
   *  `usb-c` (see `connectors.ts`). */
  connector: z.string().min(1),
  /** Number of contacts. Needed for a family that comes in several sizes (a
   *  4-way JST SH, a 15-pin header); a family of one size (USB-C) has its own. */
  ways: z.int().positive().optional(),
  pose: PoseSchema,
  interfaces: z.array(InterfaceSchema).min(1),
  note: z.string().optional(),
});

/**
 * The 3D model of a part: one GLB file. The file follows the glTF conventions
 * (metres, +Y up); the app maps glTF (x, y, z) to millimetres (x, -z, y), so
 * glTF +Y becomes +Z, and then applies `pose`. A model written for this
 * library is already in the part frame and has no `pose`.
 */
export const PartModelSchema = z.strictObject({
  /** A bundled model: the file name under the app's `parts/` folder. A model
   *  the user supplied: `custom:<sha256 of the GLB>`. */
  uri: z.string().min(1),
  /** Model frame in the part frame. Absent means identity. */
  pose: PoseSchema.optional(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  triangles: z.int().nonnegative().optional(),
  /** Licence of the model file, as an SPDX id where one exists (`CC-BY-SA-4.0`). */
  license: z.string().min(1).optional(),
  /** Who made the original, as the licence asks to be credited. */
  attribution: z.string().min(1).optional(),
  /** Where the original file was taken from. */
  source: z.url().optional(),
  /** What was changed from the original (most licences ask for this). */
  changes: z.string().optional(),
});

export const PartCategorySchema = z.enum(['controller', 'sensor', 'driver', 'actuator', 'power', 'camera', 'display', 'other']);

/**
 * A thing that gets mounted and wired: a board, a sensor, a servo.
 *
 * Part frame: origin at the centre of the mounting face, +Z pointing away
 * from the surface the part is mounted on. The part's envelope (everything it
 * occupies, pins and tall components included) is
 * x in [-sx/2, sx/2], y in [-sy/2, sy/2], z in [0, sz].
 */
export const PartSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1),
  category: PartCategorySchema,
  manufacturer: z.string().optional(),
  mpn: z.string().optional(),
  description: z.string().optional(),
  /** Other words a user might search for: `uno`, `imu`, `qwiic`. */
  tags: z.array(z.string().min(1)).default([]),
  body: z.strictObject({
    size_mm: Vec3Schema,
    /** For a circuit board: where the bare board lies inside the envelope.
     *  Used to draw a part that has no model. */
    board: z.strictObject({ z_mm: z.number().nonnegative(), thickness_mm: z.number().positive() }).optional(),
  }),
  model: PartModelSchema.optional(),
  mounting_holes: z
    .array(
      z.strictObject({
        /** Hole centre on the mounting face, in the part frame. */
        p_mm: z.tuple([z.number(), z.number()]),
        d_mm: z.number().positive(),
      }),
    )
    .default([]),
  ports: z.array(PortSchema).default([]),
  /**
   * Where the dimensions and port positions come from. `datasheet`: the
   * maker's drawing or the maker's own 3D model. `measured`: measured on a
   * sample or on a third-party model. `generic`: a stand-in with plausible
   * dimensions, not a real product.
   */
  confidence: z.enum(['datasheet', 'measured', 'generic']),
  /** The drawing, datasheet or product page the figures were read from. */
  source: z.url().optional(),
  /** Made by the user in the app, not part of the bundled library. */
  custom: z.literal(true).optional(),
});

// ---------------------------------------------------------------- cable types

/*
 * A cable TYPE is a product: a 26 AWG silicone wire, a 15-way flat flex
 * cable. The bundled ones are in `library/cables.yaml`; a design file carries
 * the user's own in the same form (`cable_types`). What a cable built from a
 * type occupies is worked out in `cables.ts`.
 */

export const CableFamilySchema = z.enum([
  'hookup_wire',
  'jumper',
  'ribbon',
  'ffc',
  'multicore',
  'twisted_pair',
  'coax',
  'usb',
  'ethernet',
  'harness',
]);

export const CrossSectionSchema = z.discriminatedUnion('shape', [
  z.strictObject({ shape: z.literal('round'), od_mm: z.number().positive() }),
  z.strictObject({ shape: z.literal('flat'), width_mm: z.number().positive(), thickness_mm: z.number().positive() }),
]);

/*
 * A cable described by a few figures, as the user enters one of their own.
 * `cableTypeFromSpec` (cables.ts) builds the type from it; the rules are in
 * docs/CABLES.md.
 */
const specCommon = {
  name: z.string().min(1).optional(),
  manufacturer: z.string().optional(),
  mpn: z.string().optional(),
  /** Where the figures the user entered come from. */
  basis: z.enum(['datasheet', 'measured']).default('measured'),
  /** Built to flex in use, across a joint. Asks for a dynamic bend radius. */
  flexing: z.boolean().default(false),
  /** The user's own bend radii, from the datasheet or a test. They replace the rules. */
  bend_static_mm: z.number().positive().max(5000).optional(),
  bend_dynamic_mm: z.number().positive().max(5000).optional(),
  /** Per conductor. */
  max_current_a: z.number().positive().optional(),
  mass_g_per_m: z.number().positive().optional(),
  connectors: z.array(z.string()).default([]),
  interfaces: z.array(InterfaceSchema).default([]),
  source: z.url().optional(),
  note: z.string().optional(),
};
/*
 * Upper bounds keep a slip of the keyboard (a length typed in metres, a pitch
 * in microns) from becoming a cable: nothing this app models is outside them.
 */
const AwgSchema = z.int().min(0).max(50);
const OdSchema = z.number().positive().max(100);
const WaysSchema = z.int().positive().max(200);
const PitchSchema = z.number().min(0.1).max(25);
const ThicknessSchema = z.number().positive().max(10);

export const CableSpecSchema = z.discriminatedUnion('kind', [
  /** One insulated wire. Give the outer diameter, or leave it out to have it estimated from the gauge. */
  z.strictObject({
    kind: z.literal('wire'),
    ...specCommon,
    awg: AwgSchema,
    od_mm: OdSchema.optional(),
    /** Insulation wall, used only when `od_mm` is not given. */
    wall_mm: z.number().positive().max(10).optional(),
  }),
  /** A jacketed round cable of several conductors. Its outer diameter must be measured or read. */
  z.strictObject({
    kind: z.literal('round_cable'),
    ...specCommon,
    family: z.enum(['multicore', 'twisted_pair', 'coax', 'usb', 'ethernet']).default('multicore'),
    conductors: WaysSchema,
    od_mm: OdSchema,
    awg: AwgSchema.optional(),
  }),
  /** Flat ribbon cable: round insulated wires side by side. */
  z.strictObject({
    kind: z.literal('ribbon'),
    ...specCommon,
    ways: WaysSchema,
    pitch_mm: PitchSchema,
    thickness_mm: ThicknessSchema.optional(),
    awg: AwgSchema.optional(),
  }),
  /**
   * Flat flex: `ffc` is the laminated jumper bought by ways and pitch, `fpc`
   * a flexible printed circuit made to the user's own layout. For an FPC the
   * thickness of the flexing part must be given (it is the fab's stack-up);
   * the width defaults to that of a standard tail, (ways + 1) x pitch.
   */
  z.strictObject({
    kind: z.literal('flat_flex'),
    ...specCommon,
    construction: z.enum(['ffc', 'fpc']),
    ways: WaysSchema,
    pitch_mm: PitchSchema,
    thickness_mm: ThicknessSchema.optional(),
    width_mm: z.number().positive().max(500).optional(),
    /** Copper layers in the part that bends. FPC only. */
    layers: z.int().min(1).max(8).default(1),
  }),
]);

export type CableSpec = z.infer<typeof CableSpecSchema>;
export type CableSpecInput = z.input<typeof CableSpecSchema>;

export const CableTypeSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1),
  family: CableFamilySchema,
  manufacturer: z.string().optional(),
  mpn: z.string().optional(),
  /** Outside of the finished cable, over its insulation or jacket. */
  section: CrossSectionSchema,
  /** Number of conductors inside one cable of this type. */
  conductors: z.int().positive(),
  /** Flat cables: centre-to-centre spacing of the conductors. A flat cable
   *  only goes into a connector made for its pitch and its number of ways. */
  pitch_mm: z.number().positive().optional(),
  /** American wire gauge of each conductor. 0 is 1/0; nothing finer than 50 is made. */
  awg: z.number().min(0).max(50).optional(),
  /**
   * Smallest radius the cable's centre line may be bent to, in mm. `static`
   * is for a cable installed once and left; `dynamic` for one that flexes in
   * use (across a joint). A flat cable bends only across its thickness.
   */
  min_bend_mm: z.strictObject({
    static: z.number().positive(),
    dynamic: z.number().positive().optional(),
  }),
  /** What the cable is built to survive. */
  flex: z.enum(['static', 'flexible', 'continuous_flex', 'torsion']),
  /** Per conductor. */
  max_current_a: z.number().positive().optional(),
  mass_g_per_m: z.number().positive().optional(),
  /** Connector families this cable is commonly terminated with. */
  connectors: z.array(z.string()).default([]),
  /** What it is typically used for. */
  interfaces: z.array(InterfaceSchema).default([]),
  /**
   * Where the numbers come from. `datasheet`: the maker's figures. `measured`:
   * measured on a sample. `derived`: computed from a datasheet value by a
   * stated rule (say which in `note`). `generic`: a typical value, not a
   * particular product.
   */
  confidence: z.enum(['datasheet', 'measured', 'derived', 'generic']),
  source: z.url().optional(),
  note: z.string().optional(),
  /** Entered by the user in the app, not part of the bundled library. */
  custom: z.literal(true).optional(),
  /**
   * The parameters a `custom` type was built from. With them the form can be
   * reopened showing exactly what was entered, so a figure the app worked
   * out never comes back looking like an entry.
   */
  spec: CableSpecSchema.optional(),
});

// ---------------------------------------------------------------- later milestones

/**
 * One physical cable in the design: `count` wires or cables of one library
 * type, laid together. Its size, bend radius and wire length follow from the
 * type and these fields (see `cables.ts`).
 */
export const CableSchema = z.strictObject({
  id: IdSchema,
  name: z.string().optional(),
  /** Electrical connections this cable carries. May be empty: a cable can be
   *  drawn between two points on the model before any connection is declared. */
  connections: z.array(IdSchema).default([]),
  /** Cable type id in the cable library. */
  type: z.string().min(1),
  /** How many of that type run together as one bundle. */
  count: z.int().positive().default(1),
  /** Whether the bundle is twisted. Twisting needs extra wire length. */
  twisted: z.boolean().default(false),
  /** Length of one full twist along the bundle. Used only when `twisted`. */
  lay_length_mm: z.number().positive().optional(),
  /** Wall thickness of a sleeve or wrap around the bundle, if any. */
  sleeve_wall_mm: z.number().nonnegative().default(0),
  /**
   * The user's own minimum bend radius for one wire of this cable, replacing
   * the library's static and dynamic values (for a wire they have measured or
   * whose datasheet they have). The bundle offset is still added on top.
   */
  bend_override_mm: z.number().positive().optional(),
  /** Cut length chosen by the user, overriding the computed one. */
  length_mm: z.number().positive().optional(),
  /** Ids of the rules that led to this choice. */
  reasons: z.array(z.string()).default([]),
});

export const CrossingStrategySchema = z.enum([
  'service_loop',
  'axial',
  'clock_spring_fpc',
  'hinge_fpc',
  'slip_ring',
  'drag_chain',
  'rolling_loop',
]);

export const RouteSchema = z.strictObject({
  id: IdSchema,
  cable: IdSchema,
  /** The port the route starts at, when it starts at one. */
  from: PortRefSchema.optional(),
  /** The port the route ends at, when it ends at one. */
  to: PortRefSchema.optional(),
  segments: z
    .array(
      z.strictObject({
        link: IdSchema,
        /** Where the cable goes on this link, in the link frame, in order. */
        points_mm: z.array(Vec3Schema).min(1),
        /**
         * One unit vector per point, or absent. A point with a non-zero normal
         * lies ON a surface and the normal points away from it: the cable's
         * centre line sits half the cable's height above the point, so the
         * same route re-seats itself when the cable type changes. A zero
         * vector marks a point the centre line passes through exactly (a
         * connector, a point in free space).
         */
        normals: z.array(Vec3Schema).optional(),
        /**
         * One flag per point, or absent. True where the wire is HELD: a point
         * the user clicked, a tie, a port. The points between holds are the
         * path first laid over the surface; the wire itself is a stiff rod
         * held only at the holds and is free to leave that path (see
         * docs/WIRE_SHAPE.md). Absent in files from before this field: the
         * holds are then worked out from the path.
         */
        ties: z.array(z.boolean()).optional(),
      }),
    )
    .default([]),
  crossings: z
    .array(
      z.strictObject({
        joint: IdSchema,
        strategy: CrossingStrategySchema,
        slack_mm: z.number().nonnegative(),
      }),
    )
    .default([]),
});

export const FixingSchema = z.strictObject({
  id: IdSchema,
  route: IdSchema,
  /** Distance along the route from its start. */
  at_mm: z.number().nonnegative(),
  part: z.string().min(1),
});

export const MountSchema = z.strictObject({
  id: IdSchema,
  component: IdSchema,
  kind: z.enum(['case', 'bracket', 'standoffs']),
  params: z.record(z.string(), z.json()).default({}),
});

export const CheckSchema = z.strictObject({
  rule: z.string().min(1),
  /** Id of the cable, route, component or mount that was checked. */
  target: z.string().min(1),
  status: z.enum(['pass', 'warn', 'fail']),
  value: z.number().optional(),
  limit: z.number().optional(),
  message: z.string().optional(),
});

// ---------------------------------------------------------------- design

export const DesignSchema = z.strictObject({
  schema: z.literal(SCHEMA_VERSION),
  // `prefault`, not `default`: the fallback is parsed like any input, so every
  // design gets its own nested arrays. A plain `default` object would hand the
  // same `links` array to every design created from defaults.
  meta: z
    .strictObject({
      name: z.string().default('Untitled'),
      notes: z.string().optional(),
    })
    .prefault({}),
  scene: SceneSchema.prefault({}),
  zones: z.array(ZoneSchema).default([]),
  /**
   * Parts this design uses that are not in the bundled library: the user's
   * own. Only the definition is stored here (size, ports, holes); the model
   * file is kept by the app and travels as a separate part file.
   */
  parts: z.array(PartSchema).default([]),
  /**
   * Cable types this design uses that are not in the bundled cable library:
   * the user's own (a flexible printed circuit they had made, a cable they
   * measured). A cable's `type` may name one of these.
   */
  cable_types: z.array(CableTypeSchema).default([]),
  components: z.array(ComponentSchema).default([]),
  connections: z.array(ConnectionSchema).default([]),
  cables: z.array(CableSchema).default([]),
  routes: z.array(RouteSchema).default([]),
  fixings: z.array(FixingSchema).default([]),
  mounts: z.array(MountSchema).default([]),
  checks: z.array(CheckSchema).default([]),
});

export type Vec3 = z.infer<typeof Vec3Schema>;
export type Quat = z.infer<typeof QuatSchema>;
export type Pose = z.infer<typeof PoseSchema>;
export type SourceKind = z.infer<typeof SourceKindSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type MeshRef = z.infer<typeof MeshRefSchema>;
export type Link = z.infer<typeof LinkSchema>;
export type JointType = z.infer<typeof JointTypeSchema>;
export type Joint = z.infer<typeof JointSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type ZoneKind = z.infer<typeof ZoneKindSchema>;
export type Zone = z.infer<typeof ZoneSchema>;
export type Component = z.infer<typeof ComponentSchema>;
export type Interface = z.infer<typeof InterfaceSchema>;
export type PortRef = z.infer<typeof PortRefSchema>;
export type Connection = z.infer<typeof ConnectionSchema>;
export type Port = z.infer<typeof PortSchema>;
export type PartModel = z.infer<typeof PartModelSchema>;
export type PartCategory = z.infer<typeof PartCategorySchema>;
export type Part = z.infer<typeof PartSchema>;
export type CableFamily = z.infer<typeof CableFamilySchema>;
export type CrossSection = z.infer<typeof CrossSectionSchema>;
export type CableType = z.infer<typeof CableTypeSchema>;
export type Cable = z.infer<typeof CableSchema>;
export type CrossingStrategy = z.infer<typeof CrossingStrategySchema>;
export type Route = z.infer<typeof RouteSchema>;
export type Fixing = z.infer<typeof FixingSchema>;
export type Mount = z.infer<typeof MountSchema>;
export type Check = z.infer<typeof CheckSchema>;
export type Design = z.infer<typeof DesignSchema>;

/** A new, empty design. */
export function emptyDesign(name = 'Untitled'): Design {
  return DesignSchema.parse({ schema: SCHEMA_VERSION, meta: { name } });
}

/** JSON Schema for the design file, for the Python backend and for
 *  schema-constrained model output. */
export function designJsonSchema(): unknown {
  return z.toJSONSchema(DesignSchema, { io: 'input' });
}
