# a Character Creator 4 FBX (CC3_Base_Plus rig) to a small GLB for the game.
#   Blender -b --python tools/convert_character.py -- <character.fbx> <out.glb>
# keeps the armature, body, boxers, eyes and teeth; drops the 300 blend shapes (that is what makes the FBX 190 MB), the camera,
# the dummy boxes and the second armature; shrinks every texture to 1024; folds each separate opacity map into its diffuse's alpha
# (glTF has no separate opacity image); writes webp textures.
import bpy, sys, numpy as np

fbx, out = sys.argv[sys.argv.index('--') + 1:][:2]
SIZE = 1024
KEEP = {'CC_Base_Body', 'Boxers', 'CC_Game_Eye', 'CC_Game_Teeth'}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx, use_anim=False, ignore_leaf_bones=False, automatic_bone_orientation=False)

rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE' and len(o.data.bones) > 50)
for o in list(bpy.data.objects):
    if o is rig or o.name in KEEP: continue
    bpy.data.objects.remove(o, do_unlink=True)
for o in bpy.data.objects:
    if o.type == 'MESH' and o.data.shape_keys:
        o.shape_key_clear()

def node_image(tree, socket_owner, socket):
    sock = socket_owner.inputs[socket]
    return sock.links[0].from_node if sock.is_linked and sock.links[0].from_node.type == 'TEX_IMAGE' else None

def shrink(img, size=SIZE):
    if img.size[0] > size: img.scale(size, size)

for mat in bpy.data.materials:
    if not mat.node_tree or not any(mat in [s.material for s in o.material_slots] for o in bpy.data.objects if o.type == 'MESH'): continue
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not bsdf: continue
    base = node_image(nt, bsdf, 'Base Color')
    alpha = node_image(nt, bsdf, 'Alpha')
    normal = next((n for n in nt.nodes if n.type == 'NORMAL_MAP'), None)
    nimg = node_image(nt, normal, 'Color') if normal else None
    if base: shrink(base.image)
    if nimg: shrink(nimg.image)
    if base and alpha:
        # one image carrying the diffuse in rgb and the opacity in alpha
        shrink(alpha.image, SIZE)
        w, h = base.image.size
        if tuple(alpha.image.size) != (w, h): alpha.image.scale(w, h)
        rgb = np.array(base.image.pixels[:], dtype=np.float32).reshape(-1, 4)
        op = np.array(alpha.image.pixels[:], dtype=np.float32).reshape(-1, 4)[:, 0]
        rgb[:, 3] = op
        merged = bpy.data.images.new(mat.name + '_rgba', w, h, alpha=True)
        merged.pixels.foreach_set(rgb.ravel())
        merged.alpha_mode = 'STRAIGHT'
        merged.pack()
        base.image = merged
        nt.links.new(base.outputs['Alpha'], bsdf.inputs['Alpha'])
        mat.surface_render_method = 'BLENDED' if mat.name.startswith('Std_Eye') else 'DITHERED'
    # a plain finish: cloth and skin are not shiny
    n = mat.name
    bsdf.inputs['Metallic'].default_value = 0.0
    bsdf.inputs['Roughness'].default_value = 0.15 if n == 'Ga_Eye' else 0.45 if n == 'Std_Nails' else 0.9 if n == 'Boxers' else 0.6
    for sock in ('Specular IOR Level',):
        if bsdf.inputs[sock].is_linked: nt.links.remove(bsdf.inputs[sock].links[0])

bpy.ops.object.select_all(action='DESELECT')
rig.select_set(True)
for o in bpy.data.objects:
    if o.type == 'MESH': o.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_apply=False, export_morph=False, export_animations=False,
    export_skins=True, export_cameras=False, export_lights=False, export_yup=True, export_image_format='WEBP', export_image_quality=85)
print('wrote', out)
