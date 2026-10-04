// Case for the Duinotech XC9026 7" HDMI touch screen ("7inch HDMI LCD(H)" board), used as the
// TimesGate Now Playing display. Three printed parts: the front bezel, the back shell, and a stand
// fin (print two). The back has keyhole slots for wall screws; the stand fins hook into the same slots.
//
// Render one part:  openscad -D 'part="bezel"' -o bezel.stl screen-case.scad   (bezel | back | fin | assembly)
//
// Coordinates, as it's used (picture upright): X to the right, Y up, both from the bottom-left corner
// of the glass. Z is depth from the front of the case (0) to its back. Measurements were taken with
// the ribbon edge at the top, so they are turned 180° below.

part = "assembly";

// ---------- measured (mm; letters as on the measurement sheet, ribbon edge at the top) ----------
A = 165;   // glass length
B = 100;   // glass height
P = 116;   // PCB height without tabs (flush with the glass at the sides)
J = 124;   // overall height with tabs
C = 7;     // black border, left        (ribbon edge at the top)
D = 4;     // black border, right
E = 10;    // black border, top (ribbon edge)
F = 4;     // black border, bottom
S = 3;     // glass left edge to hole centre
G = 157;   // hole centres, left to right
H = 116;   // hole centres, top to bottom
I = 3;     // hole diameter
K = 6;     // glass + LCD thickness
T = 1.6;   // PCB thickness
M = 15;    // front of glass to top of the tallest socket
N = 14;    // PCB ribbon edge to first socket
O = 98;    // PCB ribbon edge to last socket
Q = 25;    // PCB ribbon edge to first button
R = 84;    // PCB ribbon edge to last button

// ---------- design choices ----------
fit      = 0.4;    // clearance around the board
wall     = 2.2;    // side walls
front    = 2;      // front plate
backT    = 2;      // back plate
backGap  = 3;      // room behind the tallest part
boss_d   = 6.4;    // screw bosses in the bezel (pilot hole for an M2.5 screw)
pilot    = 2.1;
clear    = 2.9;    // M2.5 clearance through the back shell
head_d   = 5.2;    // pan head counterbore
glassGap = 0.2;    // bosses this much longer than K, so the glass never presses the bezel
win_m    = 0.5;    // window overlap past the picture edge (hides the edge of the lit area)
tilt     = 18;     // stand angle, back from vertical
key_x    = 45;     // keyholes: this far either side of the middle
key_y    = 70;     // keyhole entry centre (glass coordinates)
key_in   = 11;     // entry hole diameter (passes a screw head or the stand's hook)
key_w    = 5;      // slot width (narrower than a screw head)
key_len  = 8;      // slot length above the entry
$fn = 48;

// ---------- derived, in the as-used orientation (ribbon edge at the bottom) ----------
bL = D; bR = C; bT = F; bB = E;                   // borders turned 180°
pic = [bL, bB, A - bR, B - bT];                   // picture area x0, y0, x1, y1
pcbY0 = B / 2 - P / 2;  pcbY1 = B / 2 + P / 2;    // PCB, centred on the glass
tabY0 = B / 2 - J / 2;  tabY1 = B / 2 + J / 2;
holes = [for (x = [A - S, A - S - G]) for (y = [B / 2 - H / 2, B / 2 + H / 2]) [x, y]];
sockY = [pcbY0 + N, pcbY0 + O];                   // on the right edge
btnY  = [pcbY0 + Q, pcbY0 + R];                   // on the left edge

zGlass = front;               // front of the glass
zPcb   = zGlass + K;          // front of the PCB
zJoint = zPcb + T;            // back of the PCB: where the bezel meets the back shell
zIn    = zGlass + M + backGap;// inside of the back plate
zBack  = zIn + backT;         // back of the case

in0 = [-fit, tabY0 - fit];  in1 = [A + fit, tabY1 + fit];        // cavity
out0 = in0 - [wall, wall];  out1 = in1 + [wall, wall];           // outside
W = out1[0] - out0[0];  Ht = out1[1] - out0[1];
keys = [for (s = [-1, 1]) [A / 2 + s * key_x, key_y]];
echo(str("Case: ", W, " x ", Ht, " x ", zBack, " mm"));
echo(str("Screws: M2.5 x ", round((zBack - 1.8) - (zPcb + glassGap) + 4), " (about 4 mm into the bosses)"));

module rr(p0, p1, z0, z1, r = 2) {   // rounded box from corner p0 to p1, z0..z1
  translate([0, 0, z0]) linear_extrude(z1 - z0)
    offset(r) offset(-r) translate(p0) square(p1 - p0);
}
module box(p0, p1, z0, z1) translate([p0[0], p0[1], z0]) cube([p1[0] - p0[0], p1[1] - p0[1], z1 - z0]);

// The openings in the side walls, shared by both shells.
module side_cuts() {
  // Sockets (right): open from just in front of the glass's back to near the back plate, so plugs
  // with big moulded ends still seat fully.
  box([A - 1, sockY[0] - 6], [out1[0] + 1, sockY[1] + 4], zGlass + 1.5, zBack - 1.5);
  // Menu buttons (left): a slot level with them, to press with a fingernail or a pen.
  box([out0[0] - 1, btnY[0] - 1.5], [1, btnY[1] + 1.5], zJoint, zJoint + 4.5);
}

module bezel() {
  difference() {
    union() {
      difference() {
        rr(out0, out1, 0, zJoint);
        rr(in0, in1, front, zJoint + 1, 0.6);
      }
      for (h = holes) translate([h[0], h[1], front - 0.01])   // bosses up to the PCB
        cylinder(d = boss_d, h = zPcb - front + glassGap + 0.01);
    }
    // Picture window, bevelled on the front.
    hull() {
      box([pic[0] - win_m, pic[1] - win_m], [pic[2] + win_m, pic[3] + win_m], 1.2, front + 0.1);
      box([pic[0] - win_m - 1.3, pic[1] - win_m - 1.3], [pic[2] + win_m + 1.3, pic[3] + win_m + 1.3], -0.1, 0.01);
    }
    for (h = holes) translate([h[0], h[1], front + 1]) cylinder(d = pilot, h = 20);
    side_cuts();
  }
}

module keyhole_cut() {   // through the back plate; the slot runs up from the entry
  for (k = keys) translate([k[0], k[1], zIn - 0.1]) linear_extrude(backT + 0.2) {
    circle(d = key_in);
    hull() { circle(d = key_w); translate([0, key_len]) circle(d = key_w); }
  }
}

module back() {
  zBoss = zPcb + T + glassGap;   // standoffs press the PCB onto the bosses
  difference() {
    union() {
      difference() {
        rr(out0, out1, zJoint, zBack);
        rr(in0, in1, zJoint - 1, zIn, 0.6);
      }
      for (h = holes) translate([h[0], h[1], zBoss]) cylinder(d = 7, h = zIn - zBoss + 0.01);
      // A rib around each keyhole, so the thin plate doesn't flex under a screw head.
      for (k = keys) translate([k[0], k[1] - key_in / 2 - 2, zIn - 1.5])
        linear_extrude(1.51) difference() {
          translate([-key_in / 2 - 2, 0]) square([key_in + 4, key_in + key_len + 4]);
          translate([-key_in / 2 - 0.5, 1.5]) square([key_in + 1, key_in + key_len + 1]);
        }
    }
    for (h = holes) {
      translate([h[0], h[1], zBoss - 1]) cylinder(d = clear, h = 40);
      translate([h[0], h[1], zBack - 1.8]) cylinder(d = head_d, h = 2);   // screw heads sit flush
    }
    keyhole_cut();
    // Vents: two rows of slots across the middle.
    for (row = [0, 1]) for (i = [0 : 8])
      translate([A / 2 - 64 + i * 16, 18 + row * 22, zIn - 2]) linear_extrude(backT + 4)
        hull() { circle(d = 3); translate([0, 14]) circle(d = 3); }
    side_cuts();
  }
}

// ---------- stand fin: print two, lying flat ----------
// Side profile: its straight edge lies on the case's back, its hook goes through a keyhole and up into
// the slot, and its other two edges stand on the table, leaning the screen back by `tilt`.
finT   = 8;      // fin thickness (also the hook head's width: wider than the slot, so it can't pull out)
neck   = 4.4;    // the hook's neck: fits the slot
uKey   = key_y + key_len - out0[1];   // the slot's top, measured up the back from the bottom of the case
uTop   = uKey + 10;
foot   = uTop * sin(tilt) + 32;

module fin_profile() {   // 2D: x = distance behind the case's back at the table, y = up
  bk = function(u) [u * sin(tilt), u * cos(tilt)];
  p0 = [0, 0]; p1 = bk(uTop); p2 = [foot, 0];
  difference() {
    offset(r = 1.5) offset(delta = -1.5) polygon([p0, p1, p2]);
    offset(r = 3) offset(delta = -10) polygon([p0, p1, p2]);
  }
}
module fin() {
  // The profile, turned so its back edge runs up the Y axis (x = 0) with the case on the -x side.
  rotate([0, 0, tilt]) linear_extrude(finT) fin_profile();
  // Hook, at the slot's top on the back edge: neck through the 2 mm plate, head behind it.
  translate([0, uKey, 0]) {
    translate([-(backT + 0.4), -neck / 2, (finT - neck) / 2]) cube([backT + 0.4 + 0.5, neck, neck]);
    translate([-(backT + 0.4) - 2.2, -neck / 2, 0]) cube([2.2, neck, finT]);
  }
}

// ---------- output ----------
if (part == "bezel") bezel();                                         // print face-down (as modelled)
else if (part == "back") translate([0, 0, zBack]) mirror([0, 0, 1]) back();   // print back-down
else if (part == "fin") fin();                                        // print flat
else if (part == "section") intersection() {   // a slice through the right-hand screws, to check the fit
  union() { assembly(); }
  translate([A - S - 0.5, -50, -10]) cube([1, 300, 100]);
}
else assembly();

module assembly() {   // the board in grey
  color("#4a5552") bezel();
  color("#6b7774") back();
  color("#222") translate([0, 0, zGlass + glassGap]) cube([A, B, K]);
  color("#3f8a55") translate([0, pcbY0, zPcb + glassGap]) cube([A, P, T]);
  color("#999") translate([A - 18, sockY[0], zJoint]) cube([18, sockY[1] - sockY[0], M - K - T]);
  // the fins hooked on: fin x (behind) -> Z, fin y (up) -> Y, fin thickness -> X
  for (k = keys) color("#d99a3a") multmatrix([[0, 0, 1, k[0] - finT / 2], [0, 1, 0, out0[1]], [1, 0, 0, zBack], [0, 0, 0, 1]]) fin();
}
