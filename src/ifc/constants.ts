// Static data + IFC naming used across the editor and UI.

export const ROM_COUNTIES = [
  "Alba", "Arad", "Argeș", "Bacău", "Bihor", "Bistrița-Năsăud", "Botoșani",
  "Brașov", "Brăila", "București", "Buzău", "Caraș-Severin", "Călărași",
  "Cluj", "Constanța", "Covasna", "Dâmbovița", "Dolj", "Galați", "Giurgiu",
  "Gorj", "Harghita", "Hunedoara", "Ialomița", "Iași", "Ilfov", "Maramureș",
  "Mehedinți", "Mureș", "Neamț", "Olt", "Prahova", "Sălaj", "Satu Mare",
  "Sibiu", "Suceava", "Teleorman", "Timiș", "Tulcea", "Vâlcea", "Vaslui",
  "Vrancea",
];

export const PSET_LAND = "PSet_LandRegistration";
export const PSET_ADDRESS = "PSet_Address";
export const BENEFICIAR_REL_NAME = "Beneficiar";

// Romanian national projected CRS (Stereo 70). Used to seed IfcProjectedCRS
// when georeferencing a model. EPSG:3844 = Pulkovo 1942(58) / Stereo70.
export const STEREO70 = {
  name: "EPSG:3844",
  description: "Pulkovo 1942(58) / Stereo70",
  geodeticDatum: "Pulkovo 1942(58)",
  mapProjection: "Stereo70",
  verticalDatum: "Marea Neagră 1975",
};

// Rough Stereo 70 extents over Romania (metres) for soft validation only.
// X = Nord (Northings), Y = Est (Eastings).
export const STEREO70_BOUNDS = { eMin: 100000, eMax: 900000, nMin: 200000, nMax: 800000 };

// PSet_Address property keys (buildingSMART standard).
export const ADDRESS_PROPS = ["Street", "Town", "Region", "PostalCode", "Country"] as const;
