import { IonicModule } from '@ionic/angular';
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MapaPage } from './mapa.page';
import { MapaPageRoutingModule } from './mapa-routing.module';

@NgModule({
  imports: [IonicModule, CommonModule, FormsModule, MapaPageRoutingModule],
  declarations: [MapaPage],
})
export class MapaPageModule {}
